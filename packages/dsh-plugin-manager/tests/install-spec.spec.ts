import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { makeGatewayRoutes } from '../src/host/routes.ts'
import type { CliGateway } from '../src/host/gateway.ts'
import type { ProfileFacts } from '../src/host/profile.ts'

function loopbackPost(body: unknown): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  stream.socket = { remoteAddress: '127.0.0.1' } as IncomingMessage['socket']
  stream.headers = { host: '127.0.0.1:3082' }
  stream.method = 'POST'
  return stream
}

function captureResponse(): { res: ServerResponse; body: () => string; status: () => number } {
  let status = 200
  let text = ''
  const res = {
    writeHead(code: number) { status = code },
    end(chunk: string) { text = chunk },
  } as unknown as ServerResponse
  return { res, body: () => text, status: () => status }
}

function installHandler(installed: string[]) {
  const facts = { profileName: 'web', profileDir: '', patchPath: '', packageJsonPath: '' } as ProfileFacts
  const gateway = {
    install: (spec: string) => { installed.push(spec); return { jobId: 'job-1' } },
  } as unknown as CliGateway
  const routes = makeGatewayRoutes({ facts, gateway, cliAvailable: () => true })
  return routes.find(route => route.path === '/api/plugin-manager/install')!.handler
}

describe('install spec whitelist (B1 metacharacters)', () => {
  const refused = [
    'pkg & echo pwn',
    'pkg | calc',
    'pkg < file',
    'pkg > file',
    'pkg ^ cmd',
    'pkg %VAR%',
    'pkg ; rm -rf',
    'pkg ' + String.fromCharCode(96) + 'touch x' + String.fromCharCode(96),
    'pkg "quoted"',
    'pkg\ncmd',
  ]
  for (const spec of refused) {
    it('refuses spec: ' + JSON.stringify(spec), async () => {
      const installed: string[] = []
      const { res, body, status } = captureResponse()
      await installHandler(installed)(loopbackPost({ spec }), res)
      expect(status()).toBe(400)
      expect(JSON.parse(body())).toHaveProperty('error')
      expect(installed).toHaveLength(0)
    })
  }

  const accepted = [
    'dsh-memoir',
    'dsh-memoir@0.4.3',
    '@linxin666/dsh-pet',
    'github:owner/repo',
    'https://github.com/owner/repo',
    'link:C:/Program Files/my-plugin',
    'link:C:/Users/test/pkg',
    'file:/abs/path/pkg',
    'link:C:/Users/测试/桌面/dsh-memoir',
    'link:C:/Users/test/My Plugins/pkg',
  ]
  for (const spec of accepted) {
    it('accepts spec: ' + spec, async () => {
      const installed: string[] = []
      const { res, status } = captureResponse()
      await installHandler(installed)(loopbackPost({ spec }), res)
      expect(status()).toBe(200)
      expect(installed).toEqual([spec])
    })
  }
})
