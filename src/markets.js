// Curated CSL markets.
// - key:      internal id used by the API + frontend
// - name:     display name
// - hash:     Steam market_hash_name — used to look up the live price on lis-skins
// - image:    filename served by the FRONTEND from /public (already shipped in the site)
// - seed:     fallback / mock reference price in USD (used when MOCK=1 or the live
//             lookup has no data yet). Real prices overwrite this at runtime.
export const MARKETS = [
  { key: "dragon-lore",     name: "AWP | Dragon Lore",            hash: "AWP | Dragon Lore (Field-Tested)",              image: "cs2-awp-dragon-lore.png",      seed: 12250 },
  { key: "howl",            name: "M4A4 | Howl",                  hash: "M4A4 | Howl (Field-Tested)",                    image: "cs2-m4a4-howl.png",            seed: 5450  },
  { key: "karambit-fade",   name: "★ Karambit | Fade",            hash: "★ Karambit | Fade (Factory New)",               image: "cs2-karambit-fade-knife.jpg",  seed: 2680  },
  { key: "butterfly",       name: "★ Butterfly Knife",            hash: "★ Butterfly Knife | Doppler (Factory New)",     image: "cs2-butterfly-knife.jpg",      seed: 1840  },
  { key: "m9-doppler",      name: "★ M9 Bayonet | Doppler",       hash: "★ M9 Bayonet | Doppler (Factory New)",          image: "cs2-m9-bayonet-doppler.jpg",   seed: 1520  },
  { key: "karambit-tiger",  name: "★ Karambit | Tiger Tooth",     hash: "★ Karambit | Tiger Tooth (Factory New)",        image: "cs2-karambit-tiger-tooth.jpg", seed: 1180  },
  { key: "fire-serpent",    name: "AK-47 | Fire Serpent",         hash: "AK-47 | Fire Serpent (Field-Tested)",           image: "cs2-ak-47-fire-serpent.jpg",   seed: 920   },
  { key: "glock-fade",      name: "Glock-18 | Fade",              hash: "Glock-18 | Fade (Factory New)",                 image: "cs2-glock-fade-pistol.jpg",    seed: 880   },
  { key: "deagle-blaze",    name: "Desert Eagle | Blaze",         hash: "Desert Eagle | Blaze (Factory New)",            image: "cs2-desert-eagle-blaze.jpg",   seed: 560   },
  { key: "lightning",       name: "AWP | Lightning Strike",       hash: "AWP | Lightning Strike (Factory New)",          image: "cs2-awp-lightning-strike.jpg", seed: 410   },
  { key: "vulcan",          name: "AK-47 | Vulcan",               hash: "AK-47 | Vulcan (Factory New)",                  image: "cs2-ak-47-vulcan-skin.jpg",    seed: 305   },
  { key: "flip-doppler",    name: "★ Flip Knife | Doppler",       hash: "★ Flip Knife | Doppler (Factory New)",          image: "cs2-flip-knife-doppler.jpg",   seed: 285   },
  { key: "hyper-beast",     name: "M4A1-S | Hyper Beast",         hash: "M4A1-S | Hyper Beast (Field-Tested)",           image: "cs2-m4a1s-hyper-beast.png",    seed: 125   },
  { key: "asiimov",         name: "AWP | Asiimov",                hash: "AWP | Asiimov (Field-Tested)",                  image: "cs2-awp-asiimov-skin.jpg",     seed: 92    },
  { key: "bloodsport",      name: "AK-47 | Bloodsport",           hash: "AK-47 | Bloodsport (Factory New)",              image: "cs2-ak-47-bloodsport.jpg",     seed: 78    },
  { key: "kill-confirmed",  name: "USP-S | Kill Confirmed",       hash: "USP-S | Kill Confirmed (Field-Tested)",         image: "cs2-usp-s-kill-confirmed.jpg", seed: 44    },
  { key: "redline",         name: "AK-47 | Redline",              hash: "AK-47 | Redline (Field-Tested)",                image: "cs2-ak-47-redline-skin.jpg",   seed: 26    },
];
