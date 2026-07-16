import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';

/**
 * Replace one file through a fully-written sibling temporary. Rename is the
 * commit point, so a process/write failure leaves the previous file intact.
 */
export function replaceFileAtomically(
    target: string,
    contents: string | NodeJS.ArrayBufferView
): void {
    const temp = path.join(
        path.dirname(target),
        `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    );
    let fd: number | undefined;
    try {
        fd = fs.openSync(temp, 'wx');
        if (typeof contents === 'string') {
            fs.writeFileSync(fd, contents, { encoding: 'utf8' });
        } else {
            fs.writeFileSync(fd, contents);
        }
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(temp, target);
    } catch (err) {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* best effort */ }
        }
        try { if (fs.existsSync(temp)) { fs.unlinkSync(temp); } } catch { /* best effort */ }
        throw err;
    }
}

/**
 * Publish a set of brand-new files together. Existing targets are never
 * overwritten; if any target cannot be created, every target published by
 * this call is removed.
 */
export function createFilesAtomically(
    files: Array<{ target: string; contents: string | NodeJS.ArrayBufferView }>
): void {
    const token = `${process.pid}.${randomBytes(6).toString('hex')}`;
    const staged = files.map((file, index) => ({
        ...file,
        temp: path.join(
            path.dirname(file.target),
            `.${path.basename(file.target)}.${token}.${index}.tmp`
        )
    }));
    const published: string[] = [];
    try {
        for (const file of staged) {
            const fd = fs.openSync(file.temp, 'wx');
            try {
                if (typeof file.contents === 'string') {
                    fs.writeFileSync(fd, file.contents, { encoding: 'utf8' });
                } else {
                    fs.writeFileSync(fd, file.contents);
                }
                fs.fsyncSync(fd);
            } finally {
                fs.closeSync(fd);
            }
        }
        for (const file of staged) {
            try {
                // A hard link is an atomic, exclusive publication of the
                // already-complete sibling temporary.
                fs.linkSync(file.temp, file.target);
            } catch (err) {
                const code = (err as NodeJS.ErrnoException).code;
                if (code === 'EPERM' || code === 'ENOSYS' || code === 'ENOTSUP') {
                    fs.copyFileSync(file.temp, file.target, fs.constants.COPYFILE_EXCL);
                } else {
                    throw err;
                }
            }
            published.push(file.target);
            fs.unlinkSync(file.temp);
        }
    } catch (err) {
        for (const target of published) {
            try { if (fs.existsSync(target)) { fs.unlinkSync(target); } } catch { /* best effort */ }
        }
        for (const file of staged) {
            try { if (fs.existsSync(file.temp)) { fs.unlinkSync(file.temp); } } catch { /* best effort */ }
        }
        throw err;
    }
}
