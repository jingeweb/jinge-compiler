import { Node, Parser, Comment } from 'acorn';
import { RawSourceMap } from 'source-map';
import { base as BaseAcornVisitor } from 'acorn-walk';
import {
  BlockStatement,
  ClassDeclaration,
  ClassExpression,
  Expression,
  FunctionExpression,
  Identifier,
  MemberExpression,
  MethodDefinition,
  Program,
  Statement,
  ThisExpression,
} from 'estree';

import {
  isString,
  isArray,
  arrayIsEqual,
  SYMBOL_POSTFIX,
  sortedInsert,
  sortedIndexOf,
  ReplaceItem,
  getReplaceResult,
} from '../util';

/** 取 symbol 的前 4 位 "_b3e"，替换 this 关键字，保证不影响 sourcemap。有潜在的风险是代码里碰巧也声明了 _b3e 这个变量。 */
const VM_THIS = SYMBOL_POSTFIX.slice(0, 4);

export interface ComponentParseOptions {
  resourcePath: string;
  emitErrorFn?: (err: unknown) => void;
  /**
   * @internal
   * 是否是用于构建 jinge 内核组件
   */
  _innerLib?: boolean;
}

export class ComponentParser {
  static parse(content: string, sourceMap: RawSourceMap, options: ComponentParseOptions) {
    return new ComponentParser(options).parse(content, sourceMap);
  }

  resourcePath: string;
  source: string;
  _inserts: ReplaceItem[];
  _innerLib: boolean;

  constructor(options: ComponentParseOptions) {
    this.resourcePath = options.resourcePath;
    this._innerLib = options._innerLib;
    this._inserts = [];
  }

  _walkAcorn(node: { type: string }, visitors: Record<string, (...args: unknown[]) => void | boolean>) {
    (function c(node, state?: unknown, override?: string) {
      const found = visitors[node.type] || (override ? visitors[override] : null);
      let stopVisit = false;
      if (found) {
        if (found(node, state) === false) stopVisit = true;
      }
      if (!stopVisit) {
        BaseAcornVisitor[override || node.type](node as Node, state, c);
      }
    })(node);
  }

  walkClass(node: ClassDeclaration | ClassExpression) {
    const sc = node.superClass as unknown as { type: string; name: string };
    if (sc?.type !== 'Identifier' && sc?.name !== 'Component') {
      /* TODO: 支持 Component 有别名的写法 */
      return;
    }
    let constructorNode: MethodDefinition;
    for (let i = 0; i < node.body.body.length; i++) {
      const mem = node.body.body[i];
      if (mem.type !== 'MethodDefinition') continue;
      if (mem.kind === 'constructor') {
        constructorNode = mem;
      }
    }

    if (constructorNode) {
      this.walkConstructor(constructorNode as unknown as Node & MethodDefinition, node.id?.name || '-');
    }
  }

  _parse_mem_path(memExpr: MemberExpression, attrsName: string) {
    let paths: string[] = [];
    let computed = -1;
    let root: Expression = null;
    const walk = (node: MemberExpression) => {
      const objectExpr = node.object;
      const propertyExpr = node.property;
      if (node.computed) {
        if (propertyExpr.type === 'Literal') {
          paths.unshift(propertyExpr.value as string);
          if (computed < 0) computed = 0;
        } else {
          computed = 1;
          paths.unshift(null);
        }
      } else {
        if (propertyExpr.type !== 'Identifier') {
          throw new Error('not support');
        } else {
          paths.unshift(propertyExpr.name);
        }
      }
      if (objectExpr.type === 'ThisExpression') {
        root = objectExpr;
      } else if (objectExpr.type === 'Identifier') {
        root = objectExpr;
        paths.unshift(objectExpr.name);
      } else {
        if (objectExpr.type !== 'MemberExpression') {
          throw new Error('not support');
        } else {
          walk(objectExpr);
        }
      }
    };

    try {
      walk(memExpr);
    } catch (ex) {
      return null;
    }

    if (root.type !== 'Identifier' || root.name !== attrsName) {
      return null;
    }
    if (computed > 0) {
      // eslint-disable-next-line no-console
      console.error(
        `Warning: computed member expression is not supported.\n  > ${this.resourcePath}, line ${memExpr.loc.start.line}`,
      );
      return null;
    }

    paths = paths.slice(1);
    const privateIdx = paths.findIndex((p) => p.startsWith('_'));
    if (privateIdx >= 0) return null;
    return computed < 0 ? paths.join('.') : paths;
  }

  walkConstructor(node: Node & MethodDefinition, ClassName: string) {
    const fn = node.value as unknown as { body: Node & BlockStatement } & FunctionExpression;
    const an = fn.params.length === 0 ? null : (fn.params[0] as Identifier).name;
    if (!an) throw new Error(`constructor of ${ClassName} must accept at least one argument.`);
    let foundSupper = false;
    /** 将 this.xx 转成 vmThis.xx */
    const replaceThis = (stmt: Statement) => {
      this._walkAcorn(stmt, {
        ThisExpression: (te: ThisExpression & Node) => {
          let code = this.source;
          code = code.substring(0, te.start) + VM_THIS + code.substring(te.end);
          this.source = code;
          return false;
        },
      });
      return stmt;
    };
    const allStmts = fn.body.body as (Statement & Node)[];
    allStmts.forEach((stmt, stmtIdx) => {
      if (stmt.type === 'ReturnStatement') {
        throw new Error(`constructor of '${ClassName}' can't have return statement.`);
      }
      if (stmt.type !== 'ExpressionStatement') {
        replaceThis(stmt);
        return;
      }
      const expr = stmt.expression as Expression & Node;
      if (expr.type === 'CallExpression') {
        if (expr.callee.type === 'Super') {
          if (expr.arguments.length === 0 || (expr.arguments[0] as Identifier).name !== an) {
            throw new Error(`constructor of ${ClassName} must pass first argument '${an}' to super-class`);
          }
          foundSupper = true;
          /**
           * 在 super(); 后面添加 const VM_THIS = this[$$].proxy 代码，定义 VM_THIS 变量。接下来的转换会把 this. 替换为 VM_THIS.
           * 为了保证不影响 super(); 后续代码的 sourcemap 映射，要求 super(); 这行代码独占一行，前后都只能是空格。
           */
          const nextStmt = allStmts.length - 1 === stmtIdx ? null : allStmts[stmtIdx + 1];
          if (nextStmt && nextStmt.loc.start.line === stmt.loc.end.line) {
            // super(); 调用必须独占一行。
            throw new Error('super call expression must ends with spaces.');
          }
          // stmt.end === expr.end 说明 super() 调用后面没有加分号
          const code = `${stmt.end === expr.end ? ';' : ''}const ${VM_THIS} = this[$$${SYMBOL_POSTFIX}].proxy;`;
          sortedInsert(this._inserts, { sn: stmt.end, se: stmt.end, code });
        } else {
          replaceThis(stmt);
        }
      } else if (expr.type === 'AssignmentExpression') {
        const exprLeft = expr.left;
        if (
          exprLeft.type !== 'MemberExpression' ||
          exprLeft.object.type !== 'ThisExpression' ||
          exprLeft.property.type !== 'Identifier' ||
          exprLeft.property.name.startsWith('_') ||
          exprLeft.computed
        ) {
          replaceThis(stmt);
          return;
        }
        if (!foundSupper) throw new Error("can't use 'this' before call super().");
        const props: (string | string[])[] = [];
        const addProp = (p: string | string[]) => {
          if (isString(p) && props.indexOf(p) < 0) props.push(p);
          if (isArray(p) && !props.find((sp) => arrayIsEqual(sp as string[], p))) props.push(p);
        };
        this._walkAcorn(expr.right, {
          MemberExpression: (node: MemberExpression) => {
            const paths = this._parse_mem_path(node, an);
            if (paths) addProp(paths);
            return false;
          },
        });
        if (props.length > 0) {
          /**
           * 对于 this.xx = attrs.xx 这样的代码，需要转换为 VM_THIS.xx = attrs.xx，同时还要对 attrs 进行监听以响应外部传参变更，
           * 也就是要在代码后面添加 attrs[$$].__watch('xx', fn) 的代码。为了不影响 sourcemap，采用一个很取巧的方式。
           *
           * 比如 this.xx = attrs.xx，我们转成 const fn_ = () => { this.xx = attrs.xx; }; fn_(); attrs[$$].__watch('xx', fn_);
           * 但把 const fn_ = () => { 这一段放在上一行的末尾，从而保持 this.xx = attrs.xx; 这行和原始代码的行列都对齐。
           */

          replaceThis(stmt);
          const preStmt = allStmts[stmtIdx - 1];
          if (!preStmt) throw new Error('miss super call');
          const nextStmt = allStmts.length - 1 === stmtIdx ? null : allStmts[stmtIdx + 1];
          if (
            preStmt.loc.end.line === stmt.loc.start.line ||
            (nextStmt && stmt.loc.end.line === nextStmt.loc.start.line)
          ) {
            // 要求 this.xx = attrs.xx 的赋值语句的前后都是空格，独占一行。
            throw new Error('this assign expression line must starts and ends with spaces.');
          }
          const fnCode = `const f${stmtIdx}${SYMBOL_POSTFIX} = () => {`;

          const idx = sortedIndexOf(this._inserts, preStmt.end);
          if (idx >= 0) {
            // 如果目标的插入位置已经有数据了，则把新插入的放在原来的数据后面。
            this._inserts[idx].code += fnCode;
          } else {
            sortedInsert(this._inserts, { sn: preStmt.end, se: preStmt.end, code: fnCode });
          }

          const code =
            stmt.end === expr.end
              ? ';'
              : '' +
                ' }; ' + // 不要漏了 const fn_ = () => { 这个函数的结尾大括号
                `f${stmtIdx}${SYMBOL_POSTFIX}(); ` + // 立即执行一次赋值函数
                `${props
                  .map(
                    (prop) =>
                      `${an}[$$${SYMBOL_POSTFIX}].__watch(${JSON.stringify(prop)}, f${stmtIdx}${SYMBOL_POSTFIX});`, // 监控到变化时重新执行赋值函数
                  )
                  .join('')}`;
          sortedInsert(this._inserts, { sn: stmt.end, se: stmt.end, code });
        } else {
          replaceThis(stmt);
        }
      } else {
        replaceThis(stmt);
      }
    });
  }

  async parse(code: string, origSrcMap: RawSourceMap) {
    this.source = code;
    const comments: Comment[] = [];
    let tree;
    try {
      tree = Parser.parse(code, {
        ranges: true,
        locations: true,
        ecmaVersion: 'latest',
        sourceType: 'module',
        onComment: comments,
      }) as unknown as Program;
    } catch (ex) {
      throw new Error(ex.message + ' @ ' + this.resourcePath);
    }

    this._walkAcorn(tree, {
      ClassExpression: (node: ClassExpression) => {
        this.walkClass(node);
        return false;
      },
      ClassDeclaration: (node: ClassDeclaration) => {
        this.walkClass(node);
        return false;
      },
    });

    this.source = getReplaceResult(this._inserts, this.source);

    // this.source === code 说明没有任何变更，也就是没有找到需要处理的组件类。
    if (this.source !== code) {
      // 在文件头部插入依赖。注意不要插入 \n，保证不影响后续的行数。
      this.source =
        `import { $$ as $$${SYMBOL_POSTFIX} } from '${this._innerLib ? '../vm/common' : 'jinge'}';` + this.source;

      // console.log(this.source);
    }

    return {
      code: this.source,
      map: origSrcMap,
      ast:
        // 如果没有对文件进行任何处理，可以直接返回 ast 加速。如果有处理，则 ast 中代码的位置很难高效调整，不返回 ast。
        this.source === code
          ? {
              webpackAST: {
                ...tree,
                comments,
              },
            }
          : undefined,
    };
  }
}
