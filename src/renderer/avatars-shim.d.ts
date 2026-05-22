// Type shim for Vite asset imports used by FacePanel
declare module '*.svg?raw' {
  const content: string
  export default content
}
declare module '*.svg' {
  const url: string
  export default url
}
