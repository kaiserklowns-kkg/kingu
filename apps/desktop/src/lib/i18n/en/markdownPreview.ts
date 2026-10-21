// UI strings of the Markdown preview. Keys: 'markdownPreview.<what>'. Thai in ../th/markdownPreview.ts.
export const markdownPreview = {
	'markdownPreview.openFailed': "Can't open the preview: {error}",
	'markdownPreview.linkCopied': 'Link copied: {url}',
	'markdownPreview.linkFailed': "Can't open the link: {error}",
	'markdownPreview.linkBlocked': 'This kind of link is not opened from the preview: {url}',
	'markdownPreview.remoteImage': 'Remote images are not loaded: {src}',
	'markdownPreview.imageFailed': "Can't load the image: {src}",
	'markdownPreview.locked': 'Preview locked to {name}',
	'markdownPreview.unlocked': 'The preview follows the active Markdown editor'
} as const;
