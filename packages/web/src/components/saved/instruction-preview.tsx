import { renderMappingInstructions, type InputContract, type RepairMapping } from '@automate/core';
import { ds } from '../../design-system/tokens';

export function InstructionPreview({ mapping, contract }: { mapping: RepairMapping; contract: InputContract }) {
  return <section className={ds.card}><h3>These instructions will be sent to the AI along with a description of your new file:</h3><pre className={ds.historyPrompt}>{renderMappingInstructions(mapping, contract)}</pre></section>;
}
