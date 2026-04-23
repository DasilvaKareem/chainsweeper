// Human-readable ABIs for MachineSweepMatch + MachineSweepRatings. Hand-
// written from the Solidity so we don't need a build step for the client.
// When the contracts change, regenerate these (forge inspect can output JSON
// that we then convert — or just hand-edit; they're small).

export const MATCH_ABI = [
  // --- lifecycle
  'function createMatch(bytes32 matchId, uint8 width, uint8 height, uint16 coreCount, bytes[] cipher) external',
  'function joinMatch(bytes32 matchId) external',
  'function reveal(bytes32 matchId, uint8 x, uint8 y) external payable',

  // --- views
  'function getMatch(bytes32 matchId) view returns (tuple(address host, address guest, uint8 width, uint8 height, uint16 coreCount, uint16 safeRemaining, uint8 currentPlayer, uint8 winner, uint8 hostHealth, uint8 guestHealth, uint16 hostScore, uint16 guestScore, uint8 status))',
  'function getCell(bytes32 matchId, uint8 x, uint8 y) view returns (tuple(uint8 state, uint8 adjacency, uint8 revealedBy))',
  'function ratings() view returns (address)',

  // --- events
  'event MatchCreated(bytes32 indexed matchId, address indexed host, uint8 width, uint8 height, uint16 coreCount)',
  'event PlayerJoined(bytes32 indexed matchId, address indexed guest)',
  'event RevealRequested(bytes32 indexed matchId, uint8 player, uint8 x, uint8 y)',
  'event Revealed(bytes32 indexed matchId, uint8 player, uint8 x, uint8 y, bool wasCore, uint8 adjacency)',
  'event HealthChanged(bytes32 indexed matchId, uint8 player, uint8 health)',
  'event MatchEnded(bytes32 indexed matchId, address indexed winner, uint8 winnerSeat)',
] as const;

export const RATINGS_ABI = [
  'function getRating(address who) view returns (uint32)',
  'function players(address who) view returns (uint32 rating, uint32 matchesPlayed, uint32 wins, uint32 losses)',
  'event RatingChanged(address indexed player, uint32 oldRating, uint32 newRating, bool won, uint32 matchesPlayed)',
] as const;

// --------------------------------------------------------- Territories mode

export const PLOTS_ABI = [
  // lifecycle
  'function mintPlot(int64 x, int64 y, bytes[] cipher) external payable',
  'function revealCell(uint256 tokenId, uint8 x, uint8 y) external payable',
  'function repairPlot(uint256 tokenId, bytes[] cipher) external',

  // views
  'function getPlot(uint256 tokenId) view returns (tuple(int64 x, int64 y, uint8 status, uint8 safeRemaining, uint64 mintedAt, address lastPlayer))',
  'function getCell(uint256 tokenId, uint8 x, uint8 y) view returns (tuple(uint8 state, uint8 adjacency))',
  'function tokenIdFor(int64 x, int64 y) pure returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'function PLOT_PRICE() view returns (uint256)',
  'function setApprovalForAll(address operator, bool approved) external',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',

  // events
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event PlotMinted(uint256 indexed tokenId, address indexed owner, int64 x, int64 y)',
  'event CellRevealed(uint256 indexed tokenId, uint8 x, uint8 y, bool wasCore, uint8 adjacency)',
  'event PlotCleared(uint256 indexed tokenId, address indexed owner)',
  'event PlotCorrupted(uint256 indexed tokenId, address indexed owner, uint8 mineX, uint8 mineY)',
  'event PlotRepaired(uint256 indexed tokenId, address indexed owner)',
] as const;

export const REPAIRS_ABI = [
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function buyFromProtocol(uint256 amount) external payable',
  'function REPAIR_PRICE() view returns (uint256)',
  'function REPAIR_CORE() view returns (uint256)',
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
] as const;

export const MARKETPLACE_ABI = [
  'function list(uint256 tokenId, uint256 price) external',
  'function buy(uint256 tokenId) external payable',
  'function cancel(uint256 tokenId) external',
  'function updatePrice(uint256 tokenId, uint256 newPrice) external',
  'function getListing(uint256 tokenId) view returns (tuple(address seller, uint256 price, bool active))',
  'event Listed(uint256 indexed tokenId, address indexed seller, uint256 price)',
  'event Bought(uint256 indexed tokenId, address indexed buyer, address indexed seller, uint256 price)',
  'event Cancelled(uint256 indexed tokenId, address indexed seller)',
  'event PriceUpdated(uint256 indexed tokenId, uint256 newPrice)',
] as const;
