import fs from 'fs-extra';
import path from 'path';
export class PanelService {
    constructor(dataDir) {
        this.dataDir = dataDir;
    }
    panelsDir() {
        return path.join(this.dataDir, 'panels');
    }
    async list() {
        const dir = this.panelsDir();
        await fs.ensureDir(dir);
        const files = await fs.readdir(dir);
        const panels = [];
        for (const f of files) {
            if (!f.endsWith('.json'))
                continue;
            const p = (await fs.readJSON(path.join(dir, f)));
            panels.push(p);
        }
        return panels;
    }
    async get(id) {
        const file = path.join(this.panelsDir(), `${id}.json`);
        if (!(await fs.pathExists(file)))
            return null;
        return (await fs.readJSON(file));
    }
    async save(panel) {
        const file = path.join(this.panelsDir(), `${panel.id}.json`);
        await fs.ensureDir(path.dirname(file));
        await fs.writeJSON(file, panel, { spaces: 2 });
    }
    async remove(id) {
        const file = path.join(this.panelsDir(), `${id}.json`);
        if (await fs.pathExists(file))
            await fs.remove(file);
    }
}
