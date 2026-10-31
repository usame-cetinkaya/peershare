// Random identities: a CSS named color + an animal. The color doubles as the
// avatar background, so every entry here must be a valid CSS color keyword.
export const COLORS = [
  'Crimson', 'Tomato', 'Coral', 'Salmon', 'DarkOrange', 'Orange', 'Gold', 'Goldenrod',
  'Khaki', 'YellowGreen', 'LimeGreen', 'SeaGreen', 'ForestGreen', 'OliveDrab',
  'MediumAquamarine', 'Teal', 'LightSeaGreen', 'Turquoise', 'CadetBlue', 'SkyBlue',
  'SteelBlue', 'DodgerBlue', 'RoyalBlue', 'CornflowerBlue', 'SlateBlue', 'MediumPurple',
  'BlueViolet', 'Indigo', 'Orchid', 'Plum', 'Violet', 'HotPink', 'DeepPink',
  'PaleVioletRed', 'RosyBrown', 'SandyBrown', 'Peru', 'Sienna', 'Chocolate', 'Tan',
  'Silver', 'Thistle', 'Lavender', 'Maroon', 'Navy',
];

export const ANIMALS = {
  Fox: '🦊', Panda: '🐼', Koala: '🐨', Lion: '🦁', Tiger: '🐯', Frog: '🐸', Octopus: '🐙',
  Owl: '🦉', Penguin: '🐧', Turtle: '🐢', Butterfly: '🦋', Bee: '🐝', Dolphin: '🐬',
  Whale: '🐳', Giraffe: '🦒', Zebra: '🦓', Elephant: '🐘', Hedgehog: '🦔', Otter: '🦦',
  Sloth: '🦥', Squirrel: '🐿️', Flamingo: '🦩', Parrot: '🦜', Wolf: '🐺', Bear: '🐻',
  Rabbit: '🐰', Cat: '🐱', Dog: '🐶', Hamster: '🐹', Kangaroo: '🦘', Seal: '🦭',
  Snail: '🐌', Crab: '🦀', Ladybug: '🐞', Shark: '🦈', Crocodile: '🐊', Peacock: '🦚',
  Swan: '🦢', Raccoon: '🦝', Leopard: '🐆', Camel: '🐪', Llama: '🦙', Unicorn: '🦄',
  Monkey: '🐵', Chick: '🐥',
};

const ANIMAL_NAMES = Object.keys(ANIMALS);
const random = (list) => list[Math.floor(Math.random() * list.length)];
const key = (color, animal) => `${color} ${animal}`;

export function describe(color, animal) {
  return {
    color,
    animal,
    emoji: ANIMALS[animal],
    // "MediumAquamarine" -> "Medium Aquamarine"
    name: `${color.replace(/([a-z])([A-Z])/g, '$1 $2')} ${animal}`,
  };
}

// Keeps the requested identity when it is valid and free, otherwise picks a
// random one that no one online is using.
export function pickIdentity(color, animal, taken, avoid = null) {
  if (COLORS.includes(color) && ANIMAL_NAMES.includes(animal) && !taken.has(key(color, animal)) && avoid !== key(color, animal)) {
    return describe(color, animal);
  }
  for (let i = 0; i < 200; i++) {
    const c = random(COLORS);
    const a = random(ANIMAL_NAMES);
    const k = key(c, a);
    if (!taken.has(k) && k !== avoid) return describe(c, a);
  }
  return describe(random(COLORS), random(ANIMAL_NAMES));
}

export const identityKey = key;
