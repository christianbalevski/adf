/** The browser data-URL API used to draw channel pairing QR codes (qrcode ships no declarations). */
declare module 'qrcode' {
  export function toDataURL(text: string, options?: { width?: number; margin?: number }): Promise<string>
}
