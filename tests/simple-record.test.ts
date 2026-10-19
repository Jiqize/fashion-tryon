import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { redactSecrets } from '../src/errors.js'
import {
  countShots,
  effectiveStatus,
  listRunRecords,
  readRunRecord,
  runsDir,
  writeRunRecord,
  type RunRecord,
} from '../src/simple/record.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'simple-record-'))
  roots.push(root)
  return root
}

function sampleRecord(root: string, runId: string): RunRecord {
  const runDir = path.join(runsDir(root), runId)
  const groups: RunRecord['groups'] = [
    {
      sku: 'A1',
      referenceSource: 'crops',
      swap: 'outfit',
      promptEdited: false,
      references: [{ file: '裁图/A1/全身-正面.jpg', thumb: 'ref/A1/g1.jpg', role: '全身-正面' }],
      prompt: 'p',
      shots: [
        { model: 'A1/模特/m1.jpg', modelThumb: 'ref/A1/m1.jpg', state: 'done', result: 'out/A1-m1.png', delivered: '成图/A1/m1.png' },
        { model: 'A1/模特/m2.jpg', modelThumb: 'ref/A1/m2.jpg', state: 'queued' },
      ],
    },
  ]
  return {
    schemaVersion: 2,
    runId,
    sourceRoot: root,
    runDir,
    reportPath: path.join(runDir, 'report.html'),
    graphPath: path.join(runDir, 'graph.html'),
    engine: 'fake',
    params: { swap: 'outfit', skus: null, maxReferences: 6, engine: 'fake' },
    status: 'running',
    pid: 123,
    startedAt: '2026-10-15T01:00:00.000Z',
    finishedAt: null,
    heartbeatAt: '2026-10-15T01:00:10.000Z',
    current: { sku: 'A1', model: 'A1/模特/m2.jpg' },
    derivedFrom: null,
    groups,
    counts: countShots(groups),
  }
}

// 当前 runSimple 输出的旧格式 run.json 形状
function legacyRecord(runDir: string): unknown {
  return {
    runDir,
    reportPath: path.join(runDir, 'report.html'),
    engine: 'codex',
    groups: [
      {
        sku: 'B2',
        referenceSource: 'originals',
        references: [{ file: 'B2/服装/g.jpg', thumb: 'ref/B2/g1.jpg' }],
        prompt: 'p',
        shots: [
          { model: 'B2/模特/m1.jpg', modelThumb: 'ref/B2/m1.jpg', result: 'out/B2-m1.png', delivered: '成图/B2/m1.png' },
          { model: 'B2/模特/m2.jpg', modelThumb: 'ref/B2/m2.jpg', error: 'boom' },
        ],
      },
    ],
    counts: { delivered: 1, failed: 1, skippedGroups: 0 },
  }
}

describe('run record v2', () => {
  it('writes and reads back the same record without leftover temp files', async () => {
    const root = await makeRoot()
    const record = sampleRecord(root, '20261015-090000')
    await mkdir(record.runDir, { recursive: true })
    await writeRunRecord(record)
    expect(await readRunRecord(record.runDir)).toEqual(record)
    expect(await readdir(record.runDir)).toEqual(['run.json'])
  })

  it('normalizes legacy run.json', async () => {
    const root = await makeRoot()
    const runDir = path.join(runsDir(root), '20261014-100000')
    await mkdir(runDir, { recursive: true })
    await writeFile(path.join(runDir, 'run.json'), JSON.stringify(legacyRecord(runDir)))
    const record = await readRunRecord(runDir)
    expect(record.schemaVersion).toBe(2)
    expect(record.runId).toBe('20261014-100000')
    expect(record.params).toBeNull()
    expect(record.pid).toBeNull()
    expect(record.graphPath).toBe(path.join(runDir, 'graph.html'))
    expect(record.groups[0]?.shots.map((shot) => shot.state)).toEqual(['done', 'failed'])
    expect(record.status).toBe('partial')
    expect(record.counts).toEqual({ planned: 2, queued: 0, generating: 0, delivered: 1, failed: 1, cancelled: 0, skippedGroups: 0 })
  })

  it('fills swap, promptEdited and derivedFrom for v2 records written before them', async () => {
    const root = await makeRoot()
    const record = sampleRecord(root, '20261015-090500')
    await mkdir(record.runDir, { recursive: true })
    const { derivedFrom: _derived, ...raw } = record
    const old = {
      ...raw,
      params: { ...record.params, swap: 'top' },
      groups: record.groups.map(({ swap: _swap, promptEdited: _edited, ...group }) => group),
    }
    await writeFile(path.join(record.runDir, 'run.json'), JSON.stringify(old))
    const read = await readRunRecord(record.runDir)
    expect(read.derivedFrom).toBeNull()
    expect(read.groups.map((group) => [group.swap, group.promptEdited])).toEqual([['top', false]])
  })

  it('fills outfit swap for legacy records', async () => {
    const root = await makeRoot()
    const runDir = path.join(runsDir(root), '20261014-100500')
    await mkdir(runDir, { recursive: true })
    await writeFile(path.join(runDir, 'run.json'), JSON.stringify(legacyRecord(runDir)))
    const read = await readRunRecord(runDir)
    expect(read.derivedFrom).toBeNull()
    expect(read.groups.map((group) => [group.swap, group.promptEdited])).toEqual([['outfit', false]])
  })

  it('throws NOT_FOUND when run.json is missing', async () => {
    const root = await makeRoot()
    await expect(readRunRecord(path.join(root, 'nope'))).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('derives interrupted only for running records with a dead pid', async () => {
    const root = await makeRoot()
    const record = sampleRecord(root, '20261015-090000')
    expect(effectiveStatus(record, () => true)).toBe('running')
    expect(effectiveStatus(record, () => false)).toBe('interrupted')
    expect(effectiveStatus({ ...record, pid: null }, () => true)).toBe('interrupted')
    expect(effectiveStatus({ ...record, status: 'completed' }, () => false)).toBe('completed')
  })

  it('lists parseable runs newest first and skips the rest', async () => {
    const root = await makeRoot()
    const newer = sampleRecord(root, '20261015-090000')
    await mkdir(newer.runDir, { recursive: true })
    await writeRunRecord(newer)
    const legacyDir = path.join(runsDir(root), '20261014-100000')
    await mkdir(legacyDir, { recursive: true })
    await writeFile(path.join(legacyDir, 'run.json'), JSON.stringify(legacyRecord(legacyDir)))
    const logOnly = path.join(runsDir(root), '20261015-100000')
    await mkdir(logOnly, { recursive: true })
    await writeFile(path.join(logOnly, 'run.log'), 'x\n')
    const badName = path.join(runsDir(root), 'misc')
    await mkdir(badName, { recursive: true })
    await writeFile(path.join(badName, 'run.json'), JSON.stringify(legacyRecord(badName)))

    const runs = await listRunRecords(root)
    expect(runs.map((run) => run.runId)).toEqual(['20261015-090000', '20261014-100000'])
  })

  it('returns an empty list when _runs does not exist', async () => {
    expect(await listRunRecords(await makeRoot())).toEqual([])
  })
})

describe('redactSecrets', () => {
  it('masks bearer tokens and sk- keys', () => {
    const redacted = redactSecrets('Bearer abc sk-12345678abcd')
    expect(redacted).not.toContain('abc')
    expect(redacted).not.toContain('sk-12345678abcd')
  })
})
