declare module 'virtual:paperwork-qpdf' {
  export function openEngine(bytes: Uint8Array): Promise<{
    run(inputs: Record<string, Uint8Array>, args: string[], outputs: string[]): Record<string, Uint8Array>
  }>
}
