// types.d.ts —— 文本资源模块声明（esbuild text loader 嵌入的 UI 资产）。

declare module '*.html' {
  const content: string;
  export default content;
}

declare module '*.css' {
  const content: string;
  export default content;
}

declare module '*.svg' {
  const content: string;
  export default content;
}

// 仅用于 ui/app.js 以文本方式嵌入（esbuild loader '.js': 'text'）
// 用 *app.js 通配避免与 src 内 ESM 相对导入（./log.js 等）冲突
declare module '*app.js' {
  const content: string;
  export default content;
}
