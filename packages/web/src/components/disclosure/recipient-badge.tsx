import { ds } from '../../design-system/tokens';
export function RecipientBadge({ provider, model }: { provider: string; model: string }) {
  return <p className={ds.badge}>Recipient: {provider} <code className={ds.inlineCode}>{model}</code> · <a href="/settings">Settings</a></p>;
}
