import { expect, it } from 'vitest'
import type { WorkspacePage } from '../types/pdf'
import { unreferencedSourceIds } from './sourceRetention'

it('retains content and display origins from history/clipboard and releases expired sources', () => {
  const row: WorkspacePage = { id:'p',sourceId:'content', groupId:'display', sourcePage:0, rotation:0, annotations:[] }
  expect([...unreferencedSourceIds(['old','display','content','clip'], [[], [row]], ['clip'])]).toEqual(['old'])
  expect([...unreferencedSourceIds(['content','clip'], [[],[]], [])]).toEqual(['content','clip'])
})
