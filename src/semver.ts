/** SemVer/NuGet-style version compare with no numeric overflow. */
export function compareVersions(a: string, b: string): number {
    const normalizeNumeric = (value: string): string => {
        const normalized = value.replace(/^0+(?=\d)/, '');
        return normalized || '0';
    };
    const compareNumeric = (left: string, right: string): number => {
        const aNum = normalizeNumeric(left);
        const bNum = normalizeNumeric(right);
        if (aNum.length !== bNum.length) { return aNum.length < bNum.length ? -1 : 1; }
        return aNum === bNum ? 0 : (aNum < bNum ? -1 : 1);
    };
    const parse = (version: string) => {
        const withoutBuild = version.split('+', 1)[0];
        const dash = withoutBuild.indexOf('-');
        const core = dash >= 0 ? withoutBuild.slice(0, dash) : withoutBuild;
        const pre = dash >= 0 ? withoutBuild.slice(dash + 1).split('.') : [];
        return { core: core.split('.'), pre };
    };
    const pa = parse(a);
    const pb = parse(b);
    for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i++) {
        const order = compareNumeric(pa.core[i] ?? '0', pb.core[i] ?? '0');
        if (order !== 0) { return order; }
    }
    if (!pa.pre.length && pb.pre.length) { return 1; }
    if (pa.pre.length && !pb.pre.length) { return -1; }

    for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
        const left = pa.pre[i];
        const right = pb.pre[i];
        if (left === undefined) { return -1; }
        if (right === undefined) { return 1; }
        if (left === right) { continue; }
        const leftNumeric = /^\d+$/.test(left);
        const rightNumeric = /^\d+$/.test(right);
        if (leftNumeric && rightNumeric) { return compareNumeric(left, right); }
        if (leftNumeric !== rightNumeric) { return leftNumeric ? -1 : 1; }
        return left < right ? -1 : 1;
    }
    return 0;
}
