import { describe, expect, it } from 'vitest'

import { buildPromptFromRoles, buildSimplePrompt } from '../src/simple/prompt.js'

describe('buildPromptFromRoles', () => {
  it('matches buildSimplePrompt for the same roles', () => {
    expect(buildPromptFromRoles(['全身-正面', undefined], 'top')).toBe(buildSimplePrompt(['01-全身-正面.jpg', 'img1.webp'], 'top'))
    expect(buildPromptFromRoles([undefined, undefined])).toBe(buildSimplePrompt(['a.jpg', 'b.jpg']))
    expect(buildPromptFromRoles([undefined])).toBe(buildSimplePrompt(['a.jpg']))
  })
})
