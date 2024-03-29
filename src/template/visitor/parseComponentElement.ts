import { ITag } from '@jingeweb/html5parser';
import { convertAttributeName, prependTab, SYMBOL_POSTFIX } from '../../util';
import { throwParseError, prependTab2Space, replaceTpl } from './helper';
import { parseAttributes } from './parseAttributes';
import { TemplateVisitor } from './visitor';
import * as TPL from './tpl';
// import { parseI18nAttribute } from './parseI18nAttribute';
import { ParsedElement } from './common';
import { parseArgUseParameter } from './parseArgUseParameter';

export function parseComponentElement(
  _visitor: TemplateVisitor,
  tag: string,
  Component: string,
  inode: ITag,
): ParsedElement {
  const result = parseAttributes(_visitor, 'component', Component, inode.attributes, _visitor._parent);
  /**
   * for 组件也是一个标准组件，并没有特殊性，且组件别名也可以被覆盖。因此只给予避免踩杭的告警，
   * 而不是抛出错误。
   */
  if (tag === 'for' && !result.vms.find((v) => v.reflect === 'each')) {
    throwParseError(_visitor, inode.loc.start, '<for> component require vm:each attribute.');
  }

  let elements = _visitor.visitChildNodes(inode.body, result.vms, {
    type: 'component',
    sub: result.argPass || result.vms.length > 0 ? 'argument' : result.argUse ? 'parameter' : 'normal',
    vms: result.vms,
  });
  if (tag === '_slot' && elements.length === 0 && result.argPass) {
    throwParseError(_visitor, inode.loc.start, '<_slot> component with slot-pass: attribute must have child.');
  }
  // if (_visitor._parent.type === 'html') {
  //   _visitor._parent.hasCompChild = true;
  // }
  const hasArg = _visitor._assert_arg_pass(inode.loc.start, elements, tag);
  if (result.vms.length > 0 && !result.argPass && hasArg) {
    throwParseError(
      _visitor,
      inode.loc.start,
      "if component has vm-use: attribute but do not have slot-pass: attribute, it's root children can't have slot-pass: attribute.",
    );
  }
  const setRefCode = result.ref
    ? replaceTpl(TPL.SET_REF_ELE, {
        NAME: result.ref,
      })
    : '';
  const vmLevel = result.vms.length > 0 ? result.vms[result.vms.length - 1].level : -1;
  if (tag === '_slot' && result.argUse) {
    return parseArgUseParameter(_visitor, elements, result.argUse, result.vmPass, vmLevel);
  }

  if (tag === '_slot' && result.argPass) {
    return {
      type: 'component',
      sub: 'argument',
      argPass: result.argPass,
      value: _visitor._gen_render(elements, vmLevel),
    };
  }

  if (elements.length > 0 && !hasArg) {
    elements = [
      {
        type: 'component',
        sub: 'argument',
        argPass: 'default',
        value: _visitor._gen_render(elements, vmLevel),
      },
    ];
  }

  const attrs = [];
  result.argAttrs.length > 0 &&
    attrs.push(...result.argAttrs.map((at) => `${convertAttributeName(at.name)}: undefined`));

  result.constAttrs.length > 0 &&
    attrs.push(
      ...result.constAttrs.map((at) => {
        const cors = at.name === 'class' || at.name === 'style';
        let code = at.code;
        const isObj = /^[{[]/.test(code);
        if (cors) {
          if (isObj) code = `${at.name}2str${SYMBOL_POSTFIX}(${code})`;
        } else {
          if (isObj) code = `vm${SYMBOL_POSTFIX}(${code})`;
        }
        return `${convertAttributeName(at.name)}: ${code}`;
      }),
    );

  const vmAttrs = `const attrs = attrs${SYMBOL_POSTFIX}({
  [__${SYMBOL_POSTFIX}]: {
${_visitor._addDebugName ? `    debugName: "attrs_of_<${tag}>",` : ''}
${prependTab2Space(`  context: component[__${SYMBOL_POSTFIX}].context,`)}
${
  result.listeners.length > 0
    ? prependTab(
        `listeners: {
${result.listeners.map((lt) =>
  prependTab2Space(`${convertAttributeName(lt.name)}: {
  fn: function(...args) {
${prependTab(lt.code, false, 4)}
  },
  opts: ${lt.tag ? `${JSON.stringify(lt.tag)}` : 'null'}
}`),
)}
},`,
        false,
        4,
      )
    : ''
}
${
  elements.length > 0
    ? prependTab2Space(`  slots: {
${elements.map((el) => prependTab(`'${el.argPass}': ${el.value}`, false, 4)).join(',\n')}
  }`)
    : ''
}
  },
${prependTab2Space(attrs.join(',\n'), true)}
});
${result.argAttrs
  .map((at, i) => {
    const cors = at.name === 'class' || at.name === 'style';
    return replaceTpl(at.code, {
      REL_COM: `component[$$${SYMBOL_POSTFIX}]`,
      ROOT_INDEX: i.toString(),
      RENDER_START: `attrs.${at.name} = ${cors ? `${at.name}2str${SYMBOL_POSTFIX}(` : ''}`,
      RENDER_END: `${cors ? ')' : ''};`,
    });
  })
  .join('\n')}`;

  const code =
    // '...await (() => {\n' +
    '...(() => {\n' +
    prependTab2Space(
      `
${vmAttrs}
const el = ${Component}.create(attrs);
${setRefCode}
${_visitor._parent.type === 'component' ? replaceTpl(TPL.PUSH_ROOT_ELE) : replaceTpl(TPL.PUSH_COM_ELE)}
return el.__render();`,
      true,
    ) +
    '\n})()';

  const rtnEl: ParsedElement = {
    type: 'component',
    sub: 'normal',
    value: code,
  };

  if (result.argUse) {
    return parseArgUseParameter(_visitor, [rtnEl], result.argUse, result.vmPass, vmLevel);
  }
  if (result.argPass) {
    return {
      type: 'component',
      sub: 'argument',
      argPass: result.argPass,
      value: _visitor._gen_render([rtnEl], vmLevel),
    };
  }
  return rtnEl;
}
