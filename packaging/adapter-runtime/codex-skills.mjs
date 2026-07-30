import path from 'node:path'

const MAX_SKILLS = 64
const MAX_IDENTITY_BYTES = 512
const MAX_NAME_BYTES = 256
const MAX_DESCRIPTION_CHARS = 512

const SOURCE_LABELS = new Map([
  ['repo', 'Project skill'],
  ['user', 'User skill'],
  ['system', 'System skill'],
  ['admin', 'Admin skill'],
  ['bundled', 'Bundled skill'],
  ['plugin', 'Plugin skill'],
])

function validString(value, maxBytes) {
  return typeof value === 'string'
    && value.trim().length > 0
    && Buffer.byteLength(value, 'utf8') <= maxBytes
    && ![...value].some((character) => /\p{Cc}/u.test(character))
}

function boundedDisplay(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) return null
  return [...value].slice(0, MAX_DESCRIPTION_CHARS).join('')
}

function codexSkillMetadata(entries) {
  const skills = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    for (const skill of Array.isArray(entry?.skills) ? entry.skills : []) {
      if (skills.length >= MAX_SKILLS) return skills
      const sourceLabel = SOURCE_LABELS.get(skill?.scope)
      if (!sourceLabel
        || !validString(skill?.name, MAX_NAME_BYTES)
        || !validString(skill?.path, MAX_IDENTITY_BYTES)
        || !path.isAbsolute(skill.path)) {
        continue
      }
      const description = boundedDisplay(skill.shortDescription)
        ?? boundedDisplay(skill.interface?.shortDescription)
        ?? boundedDisplay(skill.description)
        ?? skill.name
      const metadata = {
        identity: skill.path,
        name: skill.name,
        description,
        path: skill.path,
        providerScope: skill.scope,
        sourceLabel,
        enabled: skill.enabled === true,
      }
      if (!metadata.enabled) metadata.disabledReason = 'provider_disabled'
      skills.push(metadata)
    }
  }
  return skills
}

export function advertiseCodexSkills(update, entries, supported = true) {
  return {
    ...update,
    _meta: {
      ...update._meta,
      kubecode: {
        ...update._meta?.kubecode,
        codexSkills: {
          version: 1,
          supported,
          structuredInput: true,
          textFallback: false,
          skills: supported ? codexSkillMetadata(entries) : [],
        },
      },
    },
  }
}

function structuredCodexSkill(request) {
  const structured = request?._meta?.kubecode?.providerStructuredInput
  const payload = structured?.payload
  if (structured?.adapterKind !== 'codex'
    || payload?.type !== 'skill'
    || !validString(payload.name, MAX_NAME_BYTES)
    || !validString(payload.path, MAX_IDENTITY_BYTES)
    || !path.isAbsolute(payload.path)) {
    return null
  }
  return { type: 'skill', name: payload.name, path: payload.path }
}

export function buildCodexPromptItems(request, buildPromptItems) {
  const prompt = buildPromptItems(request.prompt)
  const skill = structuredCodexSkill(request)
  return skill ? [skill, ...prompt] : prompt
}

export function codexSkillHistoryContent(input) {
  if (!validString(input?.name, MAX_NAME_BYTES)) return []
  return [{ type: 'text', text: `skill:$${input.name}` }]
}
