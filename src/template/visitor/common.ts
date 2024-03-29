export interface ParsedElement {
  type: 'html' | 'component' | 'text';
  sub?: 'argument' | 'normal' | 'parameter';
  argPass?: 'default' | string;
  value: string;
}
export interface Position {
  line: number;
  column: number;
}

export interface VM {
  name: string;
  level: number;
  reflect: string;
}

export interface Parent {
  type: 'component' | 'html';
  sub?: 'root' | 'argument' | 'parameter' | 'normal';
  vms?: VM[];
  isSVG?: boolean;
  /** 是否是 <pre> 或 <code> 标签。pre/code 标签内的文本，不需要进行 trim */
  isPreOrCodeTag?: boolean;
  // /** html 类型的元素，是否有子元素是组件类型（如果有的话，渲染函数需要是异步 await 处理） */
  // hasCompChild?: boolean;
}
