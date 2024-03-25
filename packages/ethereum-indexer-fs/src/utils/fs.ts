import * as fs from 'node:fs';
import { bnReplacer, bnReviver } from './json';


export function storage(folder: string) {
    async function get<T extends any = any>(storageID: string): Promise<T | undefined> {
        let text: string | undefined;
        try {
            text = fs.readFileSync(folder + '/' + storageID + '.json', 'utf-8');
        } catch{}
        const existingState: T | undefined = text ? JSON.parse(text, bnReviver) : undefined;
        return existingState;
    }
    
    async function set<T extends any = any>(storageID: string, data: T) {
        if (!fs.existsSync(folder)) {
            fs.mkdirSync(folder, {recursive: true});
        }
        fs.writeFileSync(folder + '/' + storageID + '.json', JSON.stringify(data, bnReplacer));
    }
    
    
    async function del(storageID: string) {
        try {
            fs.unlinkSync(folder + '/' + storageID + '.json');
        } catch{}
    }

    return {get,set,del}
}
