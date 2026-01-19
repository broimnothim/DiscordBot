import fs from 'fs-extra';
import path from 'path';
import { PanelConfig } from './TicketService.js';

export class PanelService {
  private dataDir: string;
  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  private panelsDir() {
    return path.join(this.dataDir, 'panels');
  }

  async list(): Promise<PanelConfig[]> {
    const dir = this.panelsDir();
    await fs.ensureDir(dir);
    const files = await fs.readdir(dir);
    const panels: PanelConfig[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const p = (await fs.readJSON(path.join(dir, f))) as PanelConfig;
      panels.push(p);
    }
    return panels;
  }

  async get(id: string): Promise<PanelConfig | null> {
    const file = path.join(this.panelsDir(), `${id}.json`);
    if (!(await fs.pathExists(file))) return null;
    return (await fs.readJSON(file)) as PanelConfig;
  }

  async save(panel: PanelConfig): Promise<void> {
    const file = path.join(this.panelsDir(), `${panel.id}.json`);
    await fs.ensureDir(path.dirname(file));
    await fs.writeJSON(file, panel, { spaces: 2 });
  }

  async remove(id: string): Promise<void> {
    const file = path.join(this.panelsDir(), `${id}.json`);
    if (await fs.pathExists(file)) await fs.remove(file);
  }
}
