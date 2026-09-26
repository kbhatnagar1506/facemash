[out:json][timeout:90];
(
  way["building"](33.7680,-84.4080,33.7840,-84.3880);
  relation["building"](33.7680,-84.4080,33.7840,-84.3880);
  way["highway"](33.7680,-84.4080,33.7840,-84.3880);
  way["leisure"~"park|pitch|garden|stadium|track"](33.7680,-84.4080,33.7840,-84.3880);
  way["landuse"~"grass|recreation_ground|forest|meadow"](33.7680,-84.4080,33.7840,-84.3880);
  way["natural"~"wood|water|scrub|grassland"](33.7680,-84.4080,33.7840,-84.3880);
  way["amenity"="parking"](33.7680,-84.4080,33.7840,-84.3880);
  node["natural"="tree"](33.7680,-84.4080,33.7840,-84.3880);
);
out geom;
