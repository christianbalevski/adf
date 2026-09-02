import { describe, expect, it } from 'vitest'
import { formatCodeForDisplay, isDenseCode, prettifyCode } from '../src/renderer/components/agent/code-format'

const MINIFIED =
  "const base='http://127.0.0.1:7295/agents/focus-radio/'; const before=await adf.sys_fetch({url:base+'api/likes',method:'GET',timeout_ms:10000,_reason:'Read liked state'}); const id='QlO8cHHJ2mA'; const unlike=await adf.sys_fetch({url:base+'api/feedback',method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({video_id:id,action:'unlike',category:'flow mix'}),timeout_ms:10000,_reason:'Test unlike persistence'}); const app=await adf.fs_read({path:'public/app.js',start_line:1,end_line:1000,_reason:'Validate generated app'}); new Function(app.content); const parse=x=>typeof x.body==='string'?JSON.parse(x.body):x.body; return {before:parse(before),unlikeStatus:unlike.status,syntax:'ok',features:{previous:app.content.includes(\"#previous\"),next:app.content.includes(\"#next\")}};"

describe('code-format', () => {
  it('detects dense single-line code', () => {
    expect(isDenseCode(MINIFIED)).toBe(true)
    expect(isDenseCode('const a = 1\nconst b = 2')).toBe(false)
  })

  it('breaks a minified sys_code script into readable lines', () => {
    const out = prettifyCode(MINIFIED)
    const lines = out.split('\n')
    expect(lines.length).toBeGreaterThan(20)
    // Statements each on their own line.
    expect(lines[0]).toBe("const base='http://127.0.0.1:7295/agents/focus-radio/';")
    expect(out).toContain("const id='QlO8cHHJ2mA';")
    // Object-literal args are expanded, one property per line, indented.
    expect(out).toContain("const before=await adf.sys_fetch({\n  url:base+'api/likes',\n  method:'GET',")
    // Closing brace glued to the call's `)` and `;`.
    expect(out).toContain("_reason:'Read liked state'\n});")
    // Nested object literal indents one more level.
    expect(out).toContain("  body:JSON.stringify({\n    video_id:id,")
    // Short braces stay inline.
    expect(out).toContain("headers:{'content-type':'application/json'},")
    // Strings with braces/semicolons are untouched.
    expect(out).toContain('app.content.includes("#previous")')
    // Arrow function with ternary stays on one line.
    expect(out).toContain("const parse=x=>typeof x.body==='string'?JSON.parse(x.body):x.body;")
    // Nothing lost: token stream is identical modulo whitespace.
    expect(out.replace(/\s+/g, '')).toBe(MINIFIED.replace(/\s+/g, ''))
  })

  it('does not break inside for-loop heads and keeps regex/template literals intact', () => {
    const src = "for(let i=0;i<3;i++){const re=/a;b{c}/g; const t=`x${{a:1}.a};y`; if(re.test(t)){console.log(i)}}"
    const out = prettifyCode(src)
    expect(out).toContain('for(let i=0; i<3; i++){')
    expect(out).toContain('/a;b{c}/g')
    expect(out).toContain('`x${{a:1}.a};y`')
    expect(out.replace(/\s+/g, '')).toBe(src.replace(/\s+/g, ''))
  })

  it('leaves already-formatted code alone', () => {
    const src = 'const a = 1\nif (a) {\n  console.log(a)\n}'
    expect(formatCodeForDisplay(src)).toBe(src)
  })

  it('preserves comments and existing newlines when re-flowing', () => {
    const src = '// header\nconst a=1; const b={x:1,y:2,z:3,long:"' + 'q'.repeat(60) + '"}; /* c */ const c=2;'
    const out = prettifyCode(src)
    expect(out.startsWith('// header\nconst a=1;\n')).toBe(true)
    expect(out).toContain('/* c */ const c=2;')
  })
})
