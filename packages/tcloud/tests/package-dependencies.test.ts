import { readFileSync, readdirSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Node, parseSync, visitorKeys } from 'oxc-parser'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = join(packageRoot, 'src')

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

function packageName(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/') || isBuiltin(specifier)) return null
  if (!specifier.startsWith('@')) return specifier.split('/')[0]
  return specifier.split('/').slice(0, 2).join('/')
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
}

function stringLiteral(node: Node | null | undefined): string | undefined {
  return node?.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined
}

// TypeScript 7 ships no JavaScript compiler API, so the source is parsed with oxc.
function importedPackages(path: string): string[] {
  const parsed = parseSync(path, readFileSync(path, 'utf8'))
  if (parsed.errors.length > 0) {
    throw new SyntaxError(`Cannot inspect ${path}: ${parsed.errors.map((error) => error.message).join('; ')}`)
  }
  const specifiers: string[] = []

  function addSpecifier(node: Node | null | undefined): void {
    const text = stringLiteral(node)
    if (text !== undefined) specifiers.push(text)
  }

  function visit(node: Node): void {
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
      case 'ExportNamedDeclaration':
      case 'ImportExpression':
        addSpecifier(node.source)
        break
      case 'TSExternalModuleReference':
        addSpecifier(node.expression)
        break
      case 'CallExpression':
        if (node.callee.type === 'Identifier' && node.callee.name === 'require') addSpecifier(node.arguments[0] as Node)
        break
    }
    for (const key of visitorKeys[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key]
      if (Array.isArray(child)) {
        for (const item of child) if (isNode(item)) visit(item)
      } else if (isNode(child)) {
        visit(child)
      }
    }
  }

  visit(parsed.program as unknown as Node)
  return specifiers
    .map(packageName)
    .filter((name): name is string => name !== null)
}

describe('published dependency contract', () => {
  it('declares every package imported by production source', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as Record<string, Record<string, string>>
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ])
    const imported = sourceFiles(sourceRoot).flatMap(importedPackages)
    const undeclared = [...new Set(imported.filter((name) => !declared.has(name)))].sort()

    expect(undeclared).toEqual([])
  })
})
