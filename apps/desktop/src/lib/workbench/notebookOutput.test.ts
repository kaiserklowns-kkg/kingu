import { describe, expect, test } from 'bun:test';
import { applyCarriageReturns, displayOutput, outputText, sanitizeHtml } from './notebookOutput';

describe('displayOutput', () => {
	test('the richest mime type wins', () => {
		expect(displayOutput({ output_type: 'display_data', data: { 'image/png': 'iVBO\nRw==', 'text/plain': '<Figure>' } })).toEqual({ kind: 'image', mime: 'image/png', src: 'data:image/png;base64,iVBORw==' });
		expect(displayOutput({ output_type: 'execute_result', data: { 'text/html': ['<b>x</b>'], 'text/plain': 'x' } })).toEqual({ kind: 'html', html: '<b>x</b>' });
		expect(displayOutput({ output_type: 'execute_result', data: { 'text/plain': ['4', '2'] } })).toEqual({ kind: 'text', text: '42' });
		expect(displayOutput({ output_type: 'display_data', data: { 'text/markdown': '# Hi' } })).toEqual({ kind: 'markdown', source: '# Hi' });
		expect(displayOutput({ output_type: 'display_data', data: { 'application/json': { a: 1 } } })).toEqual({ kind: 'text', text: '{\n  "a": 1\n}' });
		expect(displayOutput({ output_type: 'display_data', data: { 'application/x-thing': 1 } })).toEqual({ kind: 'unsupported', mimes: ['application/x-thing'] });
		const svg = displayOutput({ output_type: 'display_data', data: { 'image/svg+xml': '<svg onload="x()"/>' } });
		expect(svg.kind === 'image' && svg.src.startsWith('data:image/svg+xml;charset=utf-8,%3Csvg')).toBe(true);
	});

	test('streams and errors', () => {
		expect(displayOutput({ output_type: 'stream', name: 'stderr', text: ['10%\r50%\r100%\n', 'done'] })).toEqual({ kind: 'stream', name: 'stderr', text: '100%\ndone' });
		const err = displayOutput({ output_type: 'error', ename: 'ValueError', evalue: 'bad', traceback: ['\u001b[31mValueError\u001b[0m: bad', 'line 2'] });
		expect(err).toEqual({ kind: 'error', ename: 'ValueError', evalue: 'bad', text: 'ValueError: bad\nline 2' });
		expect(outputText(err)).toBe('ValueError: bad\nline 2');
		expect(outputText({ kind: 'html', html: '<b>a &amp; b</b>' })).toBe('a & b');
	});

	test('carriage returns and backspaces', () => {
		expect(applyCarriageReturns('abc\rX')).toBe('Xbc');
		expect(applyCarriageReturns('ab\b\bcd')).toBe('cd');
		expect(applyCarriageReturns('a\r\nb')).toBe('a\nb');
		expect(applyCarriageReturns('plain')).toBe('plain');
	});
});

describe('sanitizeHtml', () => {
	test('keeps tables and formatting', () => {
		const table = '<table border="1" class="dataframe"><thead><tr style="text-align: right;"><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>';
		expect(sanitizeHtml(table)).toBe('<table border="1" class="nb-dataframe"><thead><tr style="text-align: right;"><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>');
		expect(sanitizeHtml('<p>a<br/>b</p>')).toBe('<p>a<br>b</p>');
	});

	test('drops script, styles, handlers and unsafe urls', () => {
		expect(sanitizeHtml('<script>alert(1)</script><b onclick="x()">hi</b>')).toBe('<b>hi</b>');
		expect(sanitizeHtml('<style>body{display:none}</style><iframe src="x"></iframe>ok')).toBe('ok');
		expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
		expect(sanitizeHtml('<a href="&#106;avascript:alert(1)">x</a>')).toBe('<a>x</a>');
		expect(sanitizeHtml('<a href=" java\tscript:x">x</a>')).toBe('<a>x</a>');
		expect(sanitizeHtml('<a href="https://e.com/?a=1&amp;b=2">x</a>')).toBe('<a data-href="https://e.com/?a=1&amp;b=2">x</a>');
		expect(sanitizeHtml('<img src="http://evil/x.png"><img src="data:image/png;base64,AAAA" onerror="x">')).toBe('<img><img src="data:image/png;base64,AAAA">');
		expect(sanitizeHtml('<div style="background:url(http://x)">a</div>')).toBe('<div>a</div>');
		expect(sanitizeHtml('<div style="position: fixed; inset: 0">a</div>')).toBe('<div>a</div>');
		expect(sanitizeHtml('<form action="x"><input value="1"></form>t')).toBe('t');
		expect(sanitizeHtml('<svg><script>x</script></svg>s')).toBe('s');
		expect(sanitizeHtml('<!-- c --><!DOCTYPE html>a')).toBe('a');
	});

	test('stray brackets are escaped and open tags closed', () => {
		expect(sanitizeHtml('1 < 2 > 0')).toBe('1 &lt; 2 &gt; 0');
		expect(sanitizeHtml('<div><b>x')).toBe('<div><b>x</b></div>');
		expect(sanitizeHtml('<div><b>x</div>y</b>')).toBe('<div><b>x</b></div>y');
		expect(sanitizeHtml('<scr<script>ipt>alert(1)</script>')).toBe('ipt&gt;alert(1)');
	});
});
