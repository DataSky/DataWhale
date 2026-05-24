/**
 * SkillStore — Discover, match, and load DataWhale skills
 * 
 * A skill is a folder containing a SKILL.md file with YAML frontmatter
 * (name, description) and a markdown body of instructions for the agent.
 * 
 * Skills are discovered from multiple paths, matched against the user's
 * prompt, and injected into the system prompt at session start.
 * 
 * Protocol compatible with DeepSeek/codewhale SKILL.md format.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SkillMeta {
  /** Skill id (directory name) */
  id: string
  /** Human-readable name */
  name: string
  /** When to use this skill — this is the primary trigger signal */
  description: string
  /** Optional short description for listings */
  shortDescription?: string
  /** Path to the SKILL.md file */
  path: string
  /** When the skill was last modified */
  modifiedAt?: number
}

export interface Skill extends SkillMeta {
  /** Full markdown body (without frontmatter) */
  body: string
  /** Raw frontmatter fields */
  frontmatter: Record<string, string>
}

// ─── Discovery Paths ─────────────────────────────────────────────────────────

const DISCOVERY_PATHS = [
  `${process.env.HOME || "~"}/.datawhale/skills`,
  `${process.cwd()}/.datawhale/skills`,
]

// ─── SkillStore ──────────────────────────────────────────────────────────────

export class SkillStore {
  private skills: Map<string, Skill> = new Map()
  private loaded = false

  /** Discover all skills from discovery paths */
  async discover(): Promise<SkillMeta[]> {
    if (this.loaded) return this.listMetas()

    const fs = await import("node:fs")
    const path = await import("node:path")

    for (const basePath of DISCOVERY_PATHS) {
      if (!fs.existsSync(basePath)) continue

      const entries = fs.readdirSync(basePath, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue

        const skillDir = path.join(basePath, entry.name)
        const skillMd = path.join(skillDir, "SKILL.md")
        if (!fs.existsSync(skillMd)) continue

        try {
          const raw = fs.readFileSync(skillMd, "utf-8")
          const parsed = this.parseSkillMd(entry.name, skillMd, raw)
          if (parsed) {
            this.skills.set(entry.name, parsed)
          }
        } catch {
          // Skip malformed skills
        }
      }
    }

    this.loaded = true
    return this.listMetas()
  }

  /** Get a skill by id */
  get(id: string): Skill | undefined {
    return this.skills.get(id)
  }

  /** List all discovered skill metas */
  listMetas(): SkillMeta[] {
    return [...this.skills.values()].map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      shortDescription: s.shortDescription,
      path: s.path,
      modifiedAt: s.modifiedAt,
    }))
  }

  /** List all skills with full bodies */
  listAll(): Skill[] {
    return [...this.skills.values()]
  }

  /** 
   * Match skills against a user prompt.
   * Uses multi-level matching:
   * 1. Exact keyword matches in description (high weight)
   * 2. Word overlap between prompt and description (medium weight)
   * 3. Skill name in prompt (medium weight)
   */
  matchSkills(prompt: string, maxResults = 3): Skill[] {
    const promptLower = prompt.toLowerCase()
    const promptWords = this.tokenize(promptLower)

    const scored = [...this.skills.values()].map((skill) => {
      let score = 0
      const descLower = skill.description.toLowerCase()
      const nameLower = skill.name.toLowerCase()
      const idLower = skill.id.toLowerCase()

      // Level 1: Skill name/id directly mentioned in prompt
      if (promptLower.includes(nameLower) || promptLower.includes(idLower)) {
        score += 10
      }

      // Level 2: Word overlap between prompt and description
      const descWords = this.tokenize(descLower)
      const overlap = promptWords.filter((w) => descWords.includes(w))
      score += overlap.length * 2

      // Level 3: Description contains prompt words (partial match)
      for (const pw of promptWords) {
        if (pw.length > 3 && descLower.includes(pw)) {
          score += 1
        }
      }

      return { skill, score }
    })

    // Return skills with score > 0, sorted by score descending
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map((s) => s.skill)
  }

  /** Reload skills (after creating/modifying) */
  async reload(): Promise<void> {
    this.skills.clear()
    this.loaded = false
    await this.discover()
  }

  // ─── Private helpers ──────────────────────────────────────────────────

  private parseSkillMd(id: string, filePath: string, raw: string): Skill | null {
    // Parse YAML frontmatter
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
    if (!fmMatch) return null

    let frontmatter: Record<string, string> = {}
    try {
      // Use simple line-by-line parsing for robustness (avoid yaml dependency issues)
      const fmLines = fmMatch[1].split("\n")
      for (const line of fmLines) {
        const colonIdx = line.indexOf(":")
        if (colonIdx > 0) {
          const key = line.slice(0, colonIdx).trim()
          const value = line.slice(colonIdx + 1).trim()
          if (key && value) frontmatter[key] = value
        }
      }
    } catch {
      return null
    }

    const name = frontmatter.name || id
    const description = frontmatter.description || ""
    if (!description) return null // description is required

    const body = (fmMatch[2] || "").trim()

    return {
      id,
      name,
      description,
      shortDescription: frontmatter["short-description"] || frontmatter.metadata?.shortDescription,
      path: filePath,
      body,
      frontmatter,
    }
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[\s,，。？！、/\\|\(\)\[\]{}"':;<>]+/)
      .filter((w) => w.length > 2)
  }
}
