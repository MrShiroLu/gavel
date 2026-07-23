// ponytail: local-only registry (localStorage), not shared across devices or
// users. There is no on-chain or indexer-backed auction listing yet — an
// auction is only visible in "Auctions" on the browser that created it (or
// one that opened its detail link) until that's built. Good enough for a
// single-machine demo; upgrade path is an indexer query or a small registry
// contract once real, cross-device discovery matters.
const REGISTRY_KEY = 'gavel:auctions';

export type AuctionRecord = {
  address: string;
  itemDescription: string;
  createdAt: number;
};

export const listAuctions = (): AuctionRecord[] => {
  const raw = localStorage.getItem(REGISTRY_KEY);
  if (!raw) return [];
  return JSON.parse(raw) as AuctionRecord[];
};

export const addAuction = (record: AuctionRecord): void => {
  const all = listAuctions();
  if (all.some((a) => a.address === record.address)) return;
  localStorage.setItem(REGISTRY_KEY, JSON.stringify([record, ...all]));
};
