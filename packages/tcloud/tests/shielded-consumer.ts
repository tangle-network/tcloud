import { signSpendAuth, type ShieldedWallet } from '@tangle-network/tcloud/shielded'
import type { Hex } from 'viem'

export function signLocalSpend(privateKey: Hex, commitment: Hex, params: Parameters<typeof signSpendAuth>[1], fullWallet: ShieldedWallet) {
  return Promise.all([signSpendAuth({ privateKey, commitment }, params), signSpendAuth(fullWallet, params)])
}
