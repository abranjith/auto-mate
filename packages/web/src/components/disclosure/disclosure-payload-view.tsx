import { ds } from '../../design-system/tokens';
export function DisclosurePayloadView({ text, byteSize }: { text: string; byteSize: number }) {
  return <details><summary>Show exactly what will be sent ({byteSize.toLocaleString()} bytes)</summary><pre className={ds.codeBlock}>{text}</pre></details>;
}
