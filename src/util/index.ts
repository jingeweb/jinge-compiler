import path from 'path';
import fs from 'fs';

export const SYMBOL_POSTFIX = '_jg0402';
export const IMPORT_POSTFIX = '_jg0801';
export const ALIAS_POSTFIX = '_jg0812';

export function isString(v: unknown): v is string {
  return typeof v === 'string';
}

export function isObject<T = unknown>(v: T): v is T {
  return typeof v === 'object' && v !== null;
}

export function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

export function isFunction(v: unknown) {
  return typeof v === 'function';
}

export function isUndefined(v: unknown) {
  return typeof v === 'undefined';
}

export function isNull(v: unknown) {
  return v === null;
}

export function isNumber(v: unknown) {
  return typeof v === 'number';
}

export function isRegExp(v: unknown) {
  return v && v instanceof RegExp;
}

export function arrayIsEqual(arr1: unknown[], arr2: unknown[]) {
  if (arr1.length !== arr2.length) return false;
  for (let i = 0; i < arr1.length; i++) {
    if (arr1[i] !== arr2[i]) return false;
  }
  return true;
}

export function isBoolean(v: unknown): v is typeof Boolean {
  return typeof v === 'boolean' || v instanceof Boolean;
}

export function isSimpleProp(p: unknown) {
  return isString(p) && /^[\w\d$_]+$/.test(p);
}

export function isSimpleType(v: unknown) {
  return isUndefined(v) || isNull(v) || isString(v) || isNumber(v) || isBoolean(v) || isRegExp(v);
}

const SPS = ['', ' ', '  ', '   ', '    ', '     ', '      '];
export function prependTab(str: string, replaceStartEndEmpty = false, spaceCount = 2) {
  if (str.length === 0 || spaceCount === 0) return str;
  if (replaceStartEndEmpty) str = str.replace(/^(\s*\n)+/, '').replace(/(\n\s*)+$/, '');
  const spaces = spaceCount < SPS.length ? SPS[spaceCount] : ''.padStart(spaceCount, ' ');
  if (str[0] !== '\n') str = spaces + str;
  str = str.replace(/\n\s*\n/g, '\n').replace(/\n\s*[^\s]/g, (m) => '\n' + spaces + m.substring(1));
  return str;
}

export function convertAttributeName(an: string) {
  return (an.startsWith('[') && an.endsWith(']')) || /^[\w\d$_]+$/.test(an) ? an : JSON.stringify(an);
}

export async function exist(fileOrDir: string) {
  try {
    await fs.promises.access(fileOrDir);
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
    return false;
  }
}

export function existSync(fileOrDir: string) {
  try {
    fs.accessSync(fileOrDir);
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
    return false;
  }
}
export async function mkdirp(dirname: string) {
  if (await exist(dirname)) return;
  await mkdirp(path.dirname(dirname));
  await fs.promises.mkdir(dirname);
}

export function mkdirpSync(dirname: string) {
  if (existSync(dirname)) return;
  mkdirpSync(path.dirname(dirname));
  fs.mkdirSync(dirname);
}

export function deepClone<T>(obj: T): T {
  if (isArray(obj)) {
    return obj.map((v) => deepClone(v)) as unknown as T;
  } else if (obj instanceof Map) {
    const nm = new Map();
    obj.forEach((v, k) => {
      nm.set(k, deepClone(v));
    });
    return nm as unknown as T;
  } else if (isObject(obj)) {
    const no: Record<string, unknown> = {};
    for (const k in obj) {
      no[k] = deepClone(obj[k]);
    }
    return no as unknown as T;
  } else {
    return obj;
  }
}

export function sortedInsert<T extends { sn: number }>(arr: T[], el: T) {
  let high = arr.length;
  if (high === 0 || arr[high - 1].sn <= el.sn) {
    arr.push(el);
    return;
  }
  let low = 0;
  if (arr[low].sn > el.sn) {
    arr.unshift(el);
    return;
  }
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (arr[mid].sn < el.sn) low = mid + 1;
    else high = mid;
  }
  arr.splice(low, 0, el);
}

export function sortedIndexOf<T extends { sn: number }>(arr: T[], sn: T | number) {
  sn = typeof sn === 'number' ? sn : sn.sn;
  let high = arr.length;
  if (high === 0) {
    return -1;
  }
  let low = 0;
  if (arr[low].sn > sn) {
    return -1;
  }
  while (low < high) {
    const mid = (low + high) >>> 1;
    const a = arr[mid].sn;
    if (a === sn) return mid;
    else if (a < sn) low = mid + 1;
    else high = mid;
  }
  return -1;
}

export interface ReplaceItem {
  sn: number;
  se: number;
  code: string;
}
export function getReplaceResult(replaces: ReplaceItem[], source: string, range?: { start: number; end: number }) {
  if (replaces.length === 0) {
    return range ? source.substring(range.start, range.end) : source;
  }
  if (!range) range = { start: 0, end: source.length };
  let output = '';
  let idx = range.start;
  replaces.forEach((rep) => {
    if (rep.sn > idx) {
      output += source.substring(idx, rep.sn);
    }
    output += rep.code;
    idx = rep.se;
  });
  if (idx < range.end) {
    output += source.substring(idx, range.end);
  }
  return output;
}
