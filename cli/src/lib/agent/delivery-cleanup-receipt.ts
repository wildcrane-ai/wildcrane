import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export interface DeliveryCleanupReceipt {
  project: string
  task: string
  card: number
  deliveryId: string
  seq: number
  synced?: true
}

export const managedDeliveryId = (id: string): boolean => /^[a-z0-9]{8}$/.test(id)

export const deliveryCleanupDir = (cwd: string): string => path.join(cwd, '.akb', 'state', 'delivery-cleanup')

export function saveDeliveryCleanupReceipt(cwd: string, receipt: DeliveryCleanupReceipt): void {
  if (!managedDeliveryId(receipt.deliveryId) || !Number.isSafeInteger(receipt.seq) || receipt.seq <= 0) return
  const dir = deliveryCleanupDir(cwd)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${receipt.deliveryId}.json`)
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify(receipt), { flag: 'wx' })
    fs.renameSync(temp, file)
  } finally { fs.rmSync(temp, { force: true }) }
}
