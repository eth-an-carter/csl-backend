// Curated CSL markets.
// - key:      internal id used by the API + frontend
// - name:     display name
// - wear:     the exact wear this perp tracks. We pick the wear that ACTUALLY
//             trades: the most liquid tier for that skin, never Battle-Scarred.
//             For skins whose float range caps at 0.08 (Fade, Doppler, Tiger
//             Tooth, Blaze, Lightning Strike) only FN/MW exist, so FN it is.
//             For everything else Field-Tested carries the deepest order books.
// - hash:     Steam market_hash_name (wear included) — the price we track
// - image:    filename served by the FRONTEND from /public
// - seed:     fallback / mock reference price in USD
export const MARKETS = [
  { key: "dragon-lore",     name: "AWP | Dragon Lore",            wear: "FT", hash: "AWP | Dragon Lore (Field-Tested)",              image: "cs2-awp-dragon-lore.png",      seed: 12250 },
  { key: "howl",            name: "M4A4 | Howl",                  wear: "FT", hash: "M4A4 | Howl (Field-Tested)",                    image: "cs2-m4a4-howl.png",            seed: 5450  },
  { key: "karambit-fade",   name: "★ Karambit | Fade",            wear: "FN", hash: "★ Karambit | Fade (Factory New)",               image: "cs2-karambit-fade-knife.jpg",  seed: 2680  },
  { key: "butterfly",       name: "★ Butterfly Knife | Doppler",  wear: "FN", hash: "★ Butterfly Knife | Doppler (Factory New)",     image: "cs2-butterfly-knife.jpg",      seed: 1840  },
  { key: "m9-doppler",      name: "★ M9 Bayonet | Doppler",       wear: "FN", hash: "★ M9 Bayonet | Doppler (Factory New)",          image: "cs2-m9-bayonet-doppler.jpg",   seed: 1520  },
  { key: "karambit-tiger",  name: "★ Karambit | Tiger Tooth",     wear: "FN", hash: "★ Karambit | Tiger Tooth (Factory New)",        image: "cs2-karambit-tiger-tooth.jpg", seed: 1180  },
  { key: "fire-serpent",    name: "AK-47 | Fire Serpent",         wear: "FT", hash: "AK-47 | Fire Serpent (Field-Tested)",           image: "cs2-ak-47-fire-serpent.jpg",   seed: 920   },
  { key: "glock-fade",      name: "Glock-18 | Fade",              wear: "FN", hash: "Glock-18 | Fade (Factory New)",                 image: "cs2-glock-fade-pistol.jpg",    seed: 880   },
  { key: "deagle-blaze",    name: "Desert Eagle | Blaze",         wear: "FN", hash: "Desert Eagle | Blaze (Factory New)",            image: "cs2-desert-eagle-blaze.jpg",   seed: 560   },
  { key: "lightning",       name: "AWP | Lightning Strike",       wear: "FN", hash: "AWP | Lightning Strike (Factory New)",          image: "cs2-awp-lightning-strike.jpg", seed: 410   },
  { key: "flip-doppler",    name: "★ Flip Knife | Doppler",       wear: "FN", hash: "★ Flip Knife | Doppler (Factory New)",          image: "cs2-flip-knife-doppler.jpg",   seed: 285   },
  { key: "hyper-beast",     name: "M4A1-S | Hyper Beast",         wear: "FT", hash: "M4A1-S | Hyper Beast (Field-Tested)",           image: "cs2-m4a1s-hyper-beast.png",    seed: 125   },
  { key: "asiimov",         name: "AWP | Asiimov",                wear: "FT", hash: "AWP | Asiimov (Field-Tested)",                  image: "cs2-awp-asiimov-skin.jpg",     seed: 92    },
  { key: "vulcan",          name: "AK-47 | Vulcan",               wear: "FT", hash: "AK-47 | Vulcan (Field-Tested)",                 image: "cs2-ak-47-vulcan-skin.jpg",    seed: 32    },
  { key: "bloodsport",      name: "AK-47 | Bloodsport",           wear: "FT", hash: "AK-47 | Bloodsport (Field-Tested)",             image: "cs2-ak-47-bloodsport.jpg",     seed: 30    },
  { key: "kill-confirmed",  name: "USP-S | Kill Confirmed",       wear: "FT", hash: "USP-S | Kill Confirmed (Field-Tested)",         image: "cs2-usp-s-kill-confirmed.jpg", seed: 44    },
  { key: "redline",         name: "AK-47 | Redline",              wear: "FT", hash: "AK-47 | Redline (Field-Tested)",                image: "cs2-ak-47-redline-skin.jpg",   seed: 26    },
];
