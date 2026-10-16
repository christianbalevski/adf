/** The PNG promise API used by the WhatsApp adapter (qrcode ships no declarations). */
declare module 'qrcode' {
  export function toBuffer(text: string, options: { type: 'png'; width?: number }): Promise<Buffer>
}
