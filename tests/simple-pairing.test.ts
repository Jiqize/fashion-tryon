import { describe, expect, it } from 'vitest'

import { KEEP_FRAME_SENTENCE } from '../src/simple/collection.js'
import { defaultItemRef, expandPairing, type PairingInput, promptFor } from '../src/simple/pairing.js'
import { buildSimplePrompt } from '../src/simple/prompt.js'

function input(overrides: Partial<PairingInput>): PairingInput {
  return {
    sku: 'EX1',
    pairing: 'fixedGarment',
    garments: [],
    models: [],
    references: [],
    itemRefs: {},
    swap: 'outfit',
    keepFrame: false,
    halfModels: [],
    ...overrides,
  }
}

describe('expandPairing', () => {
  it('fixedGarment gives one lane with all selected models and no item', () => {
    const references = [{ file: '服装/EX1/g1.jpg' }, { file: '服装/EX1/g2.jpg' }]
    const result = expandPairing(input({
      garments: ['服装/EX1/g1.jpg', '服装/EX1/g2.jpg'],
      models: ['模特/m1.jpg', '模特/m2.jpg'],
      references,
    }))
    expect(result.lanes).toHaveLength(1)
    const lane = result.lanes[0]!
    expect(lane.item).toBeUndefined()
    expect(lane.models).toEqual(['模特/m1.jpg', '模特/m2.jpg'])
    expect(lane.references).toEqual(references)
    expect(lane.prompt).toBe(buildSimplePrompt(['服装/EX1/g1.jpg', '服装/EX1/g2.jpg'], 'outfit'))
    expect(lane.promptEdited).toBe(false)
    expect(result.unpaired).toEqual([])
  })

  it('fixedModel gives one lane per garment with a single reference', () => {
    const result = expandPairing(input({
      pairing: 'fixedModel',
      garments: ['A.jpg', 'B.jpg', 'C.jpg'],
      models: ['X.jpg'],
    }))
    expect(result.lanes.map((lane) => lane.item)).toEqual(['A.jpg', 'B.jpg', 'C.jpg'])
    for (const lane of result.lanes) {
      expect(lane.references).toHaveLength(1)
      expect(lane.references[0]!.file).toBe(lane.item)
      expect(lane.models).toEqual(['X.jpg'])
    }
  })

  it('fixedModel rejects anything but exactly one model', () => {
    expect(() => expandPairing(input({ pairing: 'fixedModel', garments: ['A.jpg'], models: ['X.jpg', 'Y.jpg'] })))
      .toThrow('EX1：固定模特只能选 1 个模特')
    expect(() => expandPairing(input({ pairing: 'fixedModel', garments: ['A.jpg'], models: [] })))
      .toThrow('EX1：固定模特只能选 1 个模特')
  })

  it('oneToOne pairs by position and reports leftovers', () => {
    const result = expandPairing(input({
      pairing: 'oneToOne',
      garments: ['A.jpg', 'B.jpg', 'C.jpg'],
      models: ['E.jpg', 'F.jpg'],
    }))
    expect(result.lanes.map((lane) => [lane.item, lane.models])).toEqual([
      ['A.jpg', ['E.jpg']],
      ['B.jpg', ['F.jpg']],
    ])
    expect(result.unpaired).toEqual(['C.jpg'])
  })

  it('rejects empty garments or models', () => {
    expect(() => expandPairing(input({ garments: [], models: ['m.jpg'], references: [] })))
      .toThrow('EX1 缺少服装图，不能出图')
    expect(() => expandPairing(input({ garments: ['g.jpg'], models: [], references: [{ file: 'g.jpg' }] })))
      .toThrow('没有勾选要出图的图')
  })

  it('keepFrame appends the sentence as the last line, once', () => {
    const result = expandPairing(input({
      pairing: 'oneToOne',
      garments: ['A.jpg', 'B.jpg'],
      models: ['E.jpg', 'F.jpg'],
      keepFrame: true,
    }))
    for (const lane of result.lanes) {
      expect(lane.prompt.split('\n').at(-1)).toBe(KEEP_FRAME_SENTENCE)
      expect(lane.keepFrame).toBe(true)
    }

    const edited = expandPairing(input({
      garments: ['g.jpg'],
      models: ['m.jpg'],
      references: [{ file: 'g.jpg' }],
      keepFrame: true,
      prompt: `自定义提示词\n${KEEP_FRAME_SENTENCE}`,
    }))
    const lane = edited.lanes[0]!
    expect(lane.promptEdited).toBe(true)
    expect(lane.prompt).toBe(`自定义提示词\n${KEEP_FRAME_SENTENCE}`)

    const added = expandPairing(input({
      garments: ['g.jpg'],
      models: ['m.jpg'],
      references: [{ file: 'g.jpg' }],
      keepFrame: true,
      prompt: '自定义提示词',
    }))
    expect(added.lanes[0]!.prompt).toBe(`自定义提示词\n${KEEP_FRAME_SENTENCE}`)
  })

  it('half models get the extra sentence only when keepFrame is off', () => {
    const base = {
      garments: ['g.jpg'],
      models: ['m1.jpg', 'm2.jpg'],
      references: [{ file: 'g.jpg' }],
      halfModels: ['m2.jpg'],
    }
    expect(expandPairing(input(base)).lanes[0]!.extraPrompts).toEqual({ 'm2.jpg': KEEP_FRAME_SENTENCE })
    expect(expandPairing(input({ ...base, keepFrame: true })).lanes[0]!.extraPrompts).toEqual({})
  })

  it('uses itemRefs as the lane reference with its role', () => {
    const result = expandPairing(input({
      pairing: 'fixedModel',
      garments: ['A.jpg', 'B.jpg'],
      models: ['X.jpg'],
      itemRefs: { 'A.jpg': '裁图/EX1/01-全身.jpg' },
    }))
    expect(result.lanes[0]!.references).toEqual([{ file: '裁图/EX1/01-全身.jpg', role: '全身' }])
    expect(result.lanes[1]!.references).toEqual([{ file: 'B.jpg' }])
  })
})

describe('defaultItemRef', () => {
  it('picks the first crop by file name that came from the garment', () => {
    expect(defaultItemRef(
      '服装/EX1/A.jpg',
      ['裁图/EX1/02-x.jpg', '裁图/EX1/01-y.jpg'],
      { '裁图/EX1/02-x.jpg': '服装/EX1/A.jpg' },
    )).toBe('裁图/EX1/02-x.jpg')
    expect(defaultItemRef('服装/EX1/A.jpg', ['裁图/EX1/01-y.jpg'], {})).toBe('服装/EX1/A.jpg')
  })
})

describe('promptFor', () => {
  it('matches buildSimplePrompt and appends the keep-frame line when asked', () => {
    const refs = [{ file: '服装/EX1/01-全身.jpg' }]
    expect(promptFor(refs, 'top', false)).toBe(buildSimplePrompt(['服装/EX1/01-全身.jpg'], 'top'))
    expect(promptFor(refs, 'top', true)).toBe(`${buildSimplePrompt(['服装/EX1/01-全身.jpg'], 'top')}\n${KEEP_FRAME_SENTENCE}`)
  })
})

describe('keep-frame sentence is not repeated', () => {
  it('skips the half-body extra when the edited prompt already has the sentence', () => {
    const result = expandPairing(input({
      garments: ['服装/EX1/g1.jpg'],
      models: ['模特/m1.jpg', '模特/m2.jpg'],
      references: [{ file: '服装/EX1/g1.jpg' }],
      prompt: `自己写的提示词\n${KEEP_FRAME_SENTENCE}`,
      halfModels: ['模特/m1.jpg'],
    }))
    expect(result.lanes[0]!.extraPrompts).toEqual({})
  })
})

describe('fixedGarment with crops only', () => {
  it('uses the crop references when the garment folder is empty', () => {
    const references = [{ file: '裁图/EX1/01-全身-正面.jpg', role: '全身-正面' }]
    const result = expandPairing(input({ garments: [], models: ['模特/m1.jpg'], references, keepFrame: true }))
    expect(result.lanes).toHaveLength(1)
    expect(result.lanes[0]!.references).toEqual(references)
  })
})
