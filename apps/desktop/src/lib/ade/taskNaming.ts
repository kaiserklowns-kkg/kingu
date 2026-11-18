// Naming a new task (Orca's new-workspace composer). Pure.
//
// Default name: an empty name field takes the prompt's words when they make a branch name, else a
// marine creature no task uses yet (Orca renderer/src/lib/workspace/creation/new-workspace.ts
// `getWorkspaceSeedName`; the pick is shared/worktree-name-suggestion.ts
// `selectSuggestedCreatureName`: a random unused name, lowercased, then `name-2`, `name-3`… tiers
// once every name is taken, shared/worktree/retired-name-registry.ts `creatureNameAtTier`).
// The names are Orca's shared/marine-creatures.ts (its primary list, then its secondary list).
//
// Branch name override: Advanced → Branch name is the whole branch name; the branch prefix setting
// is not added (Orca main/runtime/workspaces/creation/runtime-worktree-create-git.ts
// `resolveCreateBranchName`). Rust's `worktree_create` takes a prefix and a leaf, so the override
// is split at its last `/` and each part must pass the Rust rule for it.

import { firstLine } from '#lib/agent/events.ts';
import { validBranchPrefix } from './worktreeSettings.ts';

// prettier-ignore
export const MARINE_CREATURES: readonly string[] = [
	'Nautilus', 'Seahorse', 'Starfish', 'Coral', 'Narwhal', 'Jellyfish', 'Octopus', 'Manta', 'Dolphin', 'Manatee', 'Cuttlefish', 'Anemone', 'Urchin',
	'Triton', 'Nudibranch', 'Coelacanth', 'Oarfish', 'Beluga', 'Dugong', 'Porpoise', 'Stingray', 'Hammerhead', 'Wobbegong', 'Sawfish', 'Chimaera',
	'Anglerfish', 'Viperfish', 'Dragonfish', 'Axolotl', 'Otter', 'Seadragon', 'Seahare', 'Squid', 'Argonaut', 'Sponge', 'Barnacle', 'Cowrie',
	'Guitarfish', 'Lamprey', 'Isopod', 'Lionfish', 'Clownfish', 'Angelfish', 'Butterflyfish', 'Parrotfish', 'Pufferfish', 'Moonfish', 'Firefish',
	'Unicornfish', 'Rainbowfish', 'Betta', 'Discus', 'Arowana', 'Koi', 'Piranha', 'Barracuda', 'Moray', 'Sunfish', 'Lanternfish', 'Archerfish',
	'Mudskipper', 'Hatchetfish', 'Knifefish', 'Leaffish', 'Glassfish', 'Ropefish', 'Bichir', 'Tigerfish', 'Cardinalfish', 'Lungfish', 'Opah',
	'Frogfish', 'Stonefish', 'Cutlassfish', 'Paddlefish', 'Arapaima', 'Mandarin', 'Blobfish', 'Thresher', 'Vaquita', 'Pipefish', 'Guppy', 'Tetra',
	'Danio', 'Cichlid', 'Oscar', 'Gourami', 'Killifish', 'Rasbora', 'Pleco', 'Goldfish', 'Molly', 'Platy', 'Barb', 'Loach', 'Medaka', 'Pacu',
	'Filefish', 'Boxfish', 'Cowfish', 'Surgeonfish', 'Damselfish', 'Wrasse', 'Goby', 'Blenny', 'Conger', 'Sculpin', 'Darter', 'Remora', 'Pilotfish',
	'Trumpetfish', 'Cornetfish', 'Jawfish', 'Toadfish', 'Pearlfish', 'Driftfish', 'Lumpfish', 'Snailfish', 'Stickleback', 'Halfbeak', 'Snipefish',
	'Pencilfish', 'Snakehead', 'Tripletail', 'Lookdown', 'Sweetlips', 'Squirrelfish', 'Soldierfish', 'Rabbitfish', 'Hawkfish', 'Bannerfish', 'Batfish',
	'Chromis', 'Anthias', 'Fusilier', 'Sweeper', 'Emperor', 'Ponyfish', 'Kelpfish', 'Weever', 'Pearlside', 'Opaleye', 'Ballyhoo', 'Needlefish',
	'Triggerfish', 'Gar', 'Tarpon', 'Sailfish', 'Conch', 'Walrus', 'Seal', 'Penguin', 'Hagfish', 'Gulper', 'Hydra', 'Krill', 'Salp', 'Tunicate',
	'Crinoid', 'Polyp', 'Limpet', 'Whelk', 'Bowfin', 'Minnow', 'Gudgeon', 'Goldeye', 'Mooneye', 'Soapfish', 'Leatherjacket', 'Rudderfish', 'Sabrefish',
	'Puffin', 'Albatross', 'Osprey', 'Pelican', 'Petrel', 'Gannet', 'Tern', 'Cormorant', 'Leatherback', 'Hawksbill', 'Loggerhead', 'Dottyback',
	'Basslet', 'Gramma', 'Hamlet', 'Hogfish', 'Dartfish', 'Foxface', 'Shrimpfish', 'Pyrosome', 'Seapen', 'Medusa', 'Candlefish', 'Silverside', 'Shiner',
	'Eelpout', 'Madtom', 'Shovelnose', 'Sandlance', 'Tubesnout', 'Marlin', 'Bonefish', 'Dace', 'Rudd', 'Spirula', 'Permit', 'Grunt', 'Trevally',
	'Croaker', 'Drum', 'Ladyfish', 'Bullhead', 'Torpedo', 'Skate', 'Hermit', 'Fiddler', 'Fireworm', 'Tubeworm', 'Amphipod', 'Copepod', 'Pteropod',
	'Seaslug', 'Swordtail', 'Bluegill', 'Pickerel', 'Redhorse', 'Logperch', 'Goblin', 'Catshark', 'Harlequin', 'Murex', 'Volute', 'Wentletrap',
	'Nerite', 'Stargazer', 'Handfish', 'Flyingfish', 'Waspfish', 'Skua', 'Shearwater', 'Guillemot', 'Razorbill', 'Auk', 'Fulmar', 'Murre', 'Velvetfish',
	'Prowfish', 'Sandperch', 'Bobtail', 'Chiton', 'Featherstar', 'Nereid', 'Siren', 'Kraken', 'Selkie', 'Leviathan', 'Wolffish', 'Wreckfish',
	'Horseshoe', 'Orca', 'Cachalot', 'Rorqual', 'Grampus', 'Humpback', 'Bowhead', 'Finback', 'Sealion', 'Pinniped', 'Cetacean', 'Mako', 'Porbeagle',
	'Dogfish', 'Spurdog', 'Tope', 'Bonnethead', 'Sixgill', 'Sevengill', 'Angelshark', 'Houndshark', 'Megamouth', 'Cookiecutter', 'Bramble',
	'Ghostshark', 'Sandtiger', 'Galeocerdo', 'Nursehound', 'Cownose', 'Devilray', 'Eagleray', 'Butterflyray', 'Numbfish', 'Stingaree', 'Mantaray',
	'Tuna', 'Albacore', 'Bonito', 'Skipjack', 'Wahoo', 'Kingfish', 'Mackerel', 'Cero', 'Dorado', 'Mahimahi', 'Escolar', 'Pomfret', 'Butterfish', 'Cod',
	'Haddock', 'Pollock', 'Whiting', 'Hake', 'Ling', 'Cusk', 'Burbot', 'Saithe', 'Sablefish', 'Lingcod', 'Greenling', 'Rockling', 'Halibut', 'Flounder',
	'Sole', 'Plaice', 'Turbot', 'Brill', 'Dab', 'Fluke', 'Megrim', 'Sanddab', 'Herring', 'Sardine', 'Anchovy', 'Sprat', 'Pilchard', 'Menhaden', 'Shad',
	'Alewife', 'Salmon', 'Trout', 'Char', 'Grayling', 'Steelhead', 'Kokanee', 'Chinook', 'Coho', 'Sockeye', 'Taimen', 'Huchen', 'Cisco', 'Inconnu',
	'Vendace', 'Whitefish', 'Perch', 'Bass', 'Snapper', 'Grouper', 'Seabass', 'Tilefish', 'Bream', 'Porgy', 'Sheepshead', 'Pinfish', 'Scup', 'Tautog',
	'Sander', 'Zander', 'Walleye', 'Sauger', 'Ruffe', 'Comber', 'Hind', 'Coney', 'Graysby', 'Margate', 'Pompano', 'Amberjack', 'Yellowtail', 'Scad',
	'Runner', 'Mullet', 'Goatfish', 'Threadfin', 'Snook', 'Barramundi', 'Milkfish', 'Mojarra', 'Weakfish', 'Corbina', 'Queenfish', 'Kahawai', 'Tilapia',
	'Cunner', 'Tuskfish', 'Razorfish', 'Tang', 'Porcupinefish', 'Burrfish', 'Eel', 'Wolfeel', 'Gardeneel', 'Ribboneel', 'Cuskeel', 'Catfish', 'Cory',
	'Ratfish', 'Elephantfish', 'Goosefish', 'Monkfish', 'Sargassum', 'Coffinfish', 'Seadevil', 'Scorpionfish', 'Rockfish', 'Cabezon', 'Rosefish',
	'Redfish', 'Bocaccio', 'Thornyhead', 'Gurnard', 'Searobin', 'Fangtooth', 'Bristlemouth', 'Barreleye', 'Spookfish', 'Telescopefish', 'Lancetfish',
	'Tripodfish', 'Spiderfish', 'Daggertooth', 'Pearleye', 'Ridgehead', 'Snaggletooth', 'Sturgeon', 'Sterlet', 'Kaluga', 'Cockle', 'Mussel', 'Clam',
	'Oyster', 'Scallop', 'Abalone', 'Periwinkle', 'Cerith', 'Turban', 'Tellin', 'Geoduck', 'Quahog', 'Piddock', 'Shipworm', 'Lobster', 'Crayfish',
	'Shrimp', 'Prawn', 'Langostino', 'Langouste', 'Yabby', 'Marron', 'Dungeness', 'Seafan', 'Staghorn', 'Elkhorn', 'Hydroid', 'Zoanthid', 'Gorgonian',
	'Seanettle', 'Moonjelly', 'Sanddollar', 'Brittlestar', 'Basketstar', 'Sunstar', 'Seacucumber', 'Seabiscuit', 'Hearturchin', 'Bristleworm',
	'Featherduster', 'Lugworm', 'Sandworm', 'Palolo', 'Arrowworm', 'Acornworm', 'Flatworm', 'Ribbonworm', 'Booby', 'Frigatebird', 'Tropicbird', 'Noddy',
	'Kittiwake', 'Dovekie', 'Shag', 'Anhinga', 'Skimmer', 'Jaeger', 'Oystercatcher', 'Eider', 'Scoter', 'Merganser', 'Brant', 'Ridley', 'Flatback',
	'Terrapin', 'Seasnake', 'Diatom', 'Plankton', 'Larvacean', 'Doliolid', 'Kelp', 'Seagrass', 'Eelgrass', 'Dulse', 'Bladderwrack', 'Mola', 'Scylla',
	'Charybdis', 'Cetus', 'Proteus', 'Glaucus', 'Hippocamp', 'Jormungandr', 'Hafgufa', 'Kelpie', 'Merrow', 'Nuckelavee', 'Afanc', 'Rusalka', 'Vodyanoy',
	'Umibozu', 'Isonade', 'Ningyo', 'Mizuchi', 'Naga', 'Makara', 'Bunyip', 'Taniwha', 'Marakihau', 'Lusca', 'Undine', 'Nixie', 'Melusine', 'Ondine',
	'Tiamat', 'Dagon', 'Aspidochelone', 'Capricorn', 'Merfolk', 'Merman', 'Mermaid', 'Timingila', 'Bakekujira', 'Jiaolong', 'Encantado', 'Hraesvelg'

];

/** Orca `normalizeSuggestedName`. */
const normalize = (name: string) => name.trim().toLowerCase();

/** Orca `creatureNameAtTier`: tier 1 is the bare name, tier N is `name-N`. */
export const creatureNameAtTier = (name: string, tier: number) => (tier === 1 ? name : `${name}-${tier}`);

/**
 * Orca `selectSuggestedCreatureName`: a random creature no name in `used` has (compared lowercased);
 * when all are taken, a random free `name-2`, then `name-3`…
 */
export function suggestCreatureName(used: Iterable<string>, random: () => number = Math.random): string {
	const taken = new Set<string>();
	for (const name of used) taken.add(normalize(name));
	for (let tier = 1; ; tier++) {
		const free = MARINE_CREATURES.map((name) => creatureNameAtTier(normalize(name), tier)).filter((name) => !taken.has(name));
		if (free.length) return free[Math.floor(random() * free.length)];
	}
}

/** The longest title taken from a prompt. */
const MAX_PROMPT_TITLE = 80;

export type TaskName = {
	title: string;
	/** The name is a creature: nothing the user wrote, so it is never sent to the agent as the prompt. */
	generated: boolean;
};

/**
 * Orca `getWorkspaceSeedName` for a task with no issue or pull request: the typed name; else the
 * prompt's first line when it has letters a branch name can keep; else `creature`.
 */
export function taskName(name: string, prompt: string, creature: string): TaskName {
	if (name.trim()) return { title: name.trim(), generated: false };
	const line = firstLine(prompt).trim();
	// Nothing a slug keeps (a prompt in Thai, emoji…) is Orca's empty slug: the creature names it.
	if (/[a-z0-9]/i.test(line.normalize('NFKD'))) return { title: line.slice(0, MAX_PROMPT_TITLE).trim(), generated: false };
	return { title: creature, generated: true };
}

/** The same rule as Rust's `validate_leaf` (agent/worktree.rs). */
const LEAF = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;

export type BranchOverride = { prefix: string; leaf: string };

/**
 * A typed branch name as the `prefix` and `leaf` Rust's `worktree_create` takes (`feature/my-branch`
 * → `feature/` + `my-branch`; no `/`: an empty prefix). null when a part breaks its Rust rule
 * (`validate_prefix`, `validate_leaf`), so the form can say so before git is asked. Like Orca, a
 * name starting with `-` is refused.
 */
export function splitBranchOverride(value: string): BranchOverride | null {
	const name = value.trim();
	const cut = name.lastIndexOf('/') + 1;
	const prefix = name.slice(0, cut);
	const leaf = name.slice(cut);
	if (!LEAF.test(leaf) || leaf.endsWith('-') || leaf.includes('--')) return null;
	return validBranchPrefix(prefix) ? { prefix, leaf } : null;
}
