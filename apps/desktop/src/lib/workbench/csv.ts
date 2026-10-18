// CSV/TSV parsing for the CSV preview (Orca's CsvViewer): RFC 4180 quoting, either delimiter.

/** Rows of fields. Quoted fields may hold the delimiter, `""` and newlines; a trailing newline adds no row. */
export function parseCsv(text: string, delimiter = ','): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
			else if (c === '"') quoted = false;
			else field += c;
		} else if (c === '"' && field === '') quoted = true;
		else if (c === delimiter) row.push(field), (field = '');
		else if (c === '\n' || c === '\r') {
			if (c === '\r' && text[i + 1] === '\n') i++;
			row.push(field);
			rows.push(row);
			(row = []), (field = '');
		} else field += c;
	}
	if (field !== '' || row.length) row.push(field), rows.push(row);
	return rows;
}

export const delimiterFor = (path: string) => (/\.tsv$/i.test(path) ? '\t' : ',');
