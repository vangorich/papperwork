// node tests/ofdFixture.ts path/to/sample.ofd (Node 22.18+). Synthetic;
// no external files, fonts, network or confidential invoice data required.
import { zipSync, strToU8 } from 'fflate'
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const ns = 'xmlns:o="http://www.ofdspec.org/2016"'
export const ofdPage = (content: string) => `<o:Page ${ns}>${content}</o:Page>`
export const ofdManifest = (body: string) => `<o:OFD ${ns} Version="1.0" DocType="OFD">${body}</o:OFD>`
export const firstPage = 'Doc_0/Pages/P9/Content.xml'
export const secondPage = 'Doc_0/Pages/P1/Content.xml'
const fill = (value: string) => `<o:FillColor Value="${value}"/>`
const rect = (id: number, color: string, box: string, w: number, h: number) => `<o:PathObject ID="${id}" Boundary="${box}" Fill="true" Stroke="false">${fill(color)}<o:AbbreviatedData>M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} C</o:AbbreviatedData></o:PathObject>`
const text = (id: number, s: string, delta: number) => `<o:TextObject ID="${id}" Font="4" Size="6" Boundary="5 10 89 16"><o:TextCode X="1" Y="8" DeltaX="g ${Array.from(s).length - 1} ${delta}">${s}</o:TextCode></o:TextObject>`
export function makeOfdFixture(overrides: Record<string, string | Uint8Array | null> = {}) {
  const files: Record<string, string | Uint8Array | null> = {
    'OFD.xml': ofdManifest('<o:DocBody><o:DocInfo><o:Title>合成单据</o:Title></o:DocInfo><o:DocRoot>/Doc_0/Document.xml</o:DocRoot></o:DocBody>'),
    'Doc_0/Document.xml': `<o:Document ${ns}><o:CommonData><o:PageArea><o:PhysicalBox>0 0 100 70</o:PhysicalBox></o:PageArea><o:PublicRes>Resources/Public.xml</o:PublicRes><o:TemplatePage ID="8" BaseLoc="Tpl/Content.xml"/></o:CommonData><o:Pages><o:Page ID="9" BaseLoc="Pages/P9/Content.xml"/><o:Page ID="1" BaseLoc="Pages/P1/Content.xml"/></o:Pages></o:Document>`,
    'Doc_0/Resources/Public.xml': `<o:Res ${ns} BaseLoc="../Assets"><o:Fonts><o:Font ID="4" FontName="Microsoft YaHei"/></o:Fonts><o:MultiMedias><o:MultiMedia ID="5" Type="Image" Format="PNG"><o:MediaFile>black.png</o:MediaFile></o:MultiMedia></o:MultiMedias></o:Res>`,
    'Doc_0/Assets/black.png': Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')),
    'Doc_0/Tpl/Content.xml': ofdPage(`<o:Content><o:Layer ID="22">${rect(23, '24 96 176', '0 0 100 5', 100, 5)}</o:Layer></o:Content>`),
    [firstPage]: ofdPage(`<o:Template TemplateID="8"/><o:Content><o:Layer ID="30">${rect(31, '210 36 42', '5 28 22 10', 22, 10)}${text(32, '发票样张', 6)}<o:ImageObject ID="33" Boundary="45 28 12 10" CTM="12 0 0 10 0 0" ResourceID="5"/></o:Layer></o:Content>`),
    [secondPage]: ofdPage(`<o:Area><o:PhysicalBox>2 3 80 110</o:PhysicalBox></o:Area><o:Content><o:Layer ID="40">${rect(41, '44 162 90', '5 28 52 12', 52, 12)}${text(42, 'Page Two', 3.2)}</o:Layer></o:Content>`),
    ...overrides,
  }
  return zipSync(Object.fromEntries(Object.entries(files).filter((entry): entry is [string, string | Uint8Array] => entry[1] !== null)
    .map(([path, value]) => [path, typeof value === 'string' ? strToU8(value) : value])), { mtime: new Date(2020, 0, 1) })
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Usage: node tests/ofdFixture.ts output.ofd')
  writeFileSync(process.argv[2], makeOfdFixture(), { flag: 'wx' })
}
