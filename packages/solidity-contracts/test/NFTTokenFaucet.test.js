// eslint-disable-next-line @typescript-eslint/no-var-requires
const truffleAssert = require('truffle-assertions');
const timeMachine = require('ganache-time-traveler');

const MockTokenLockManager = artifacts.require('MockTokenLockManager');
const BVAL20 = artifacts.require('BVAL20');
const BVAL721 = artifacts.require('BVAL721');
const NFTTokenFaucet = artifacts.require('NFTTokenFaucet');

// set the date of the local blockchain
const setNetworkTime = async (date) => {
  const timestamp = Math.round(new Date(date).getTime() / 1000);
  await timeMachine.advanceBlockAndSetTime(timestamp);
};

// lol... just want a large number so we dont underflow during division
const BN = (amount) => `${amount}000000000000000000`;

// helps keeps tests more consistent when messing with network time
let snapshotId;
beforeEach(async () => {
  const snapshot = await timeMachine.takeSnapshot();
  snapshotId = snapshot['result'];
});
afterEach(async () => {
  await timeMachine.revertToSnapshot(snapshotId);
});

const TOKENS = [
  // token #1, sequence 1, minted 2021-03-29, 1000x output mult
  '0x013d00010001491b48a300010001010960096003e80000000000000000000001',
  // token #29, sequence 6, minted 2021-05-01, 1000x output mult
  '0x01aa00010006493c492e00010001010e100e1003e8000000000000000000001d',
];

// start a sequence and mint
const simpleMint = async (instance, tokenId = TOKENS[0], date = '2021-03-29') => {
  await instance.startSequence({ sequenceNumber: '1', name: 'name', description: 'desc', image: 'data' });
  await instance.startSequence({ sequenceNumber: '6', name: 'name', description: 'desc', image: 'data' });
  await setNetworkTime(date);
  const res = await instance.mint({
    tokenId,
    metadataCIDs: ['cid'],
  });
  return res;
};

const factory = async () => {
  const nft = await BVAL721.new();
  const token = await BVAL20.new();
  const lock = await MockTokenLockManager.new(nft.address);
  const faucet = await NFTTokenFaucet.new({ token: token.address, nft: nft.address, lock: lock.address });
  await faucet.setBaseDailyRate(BN(1)); // token has a 1000x multiplier
  await faucet.setMaxClaimAllowed(BN(10000));
  return { nft, token, lock, faucet };
};

// gas
const MAX_DEPLOYMENT_GAS = 1600000;
const MAX_MUTATION_GAS = 110000;

contract('NFTTokenFaucet', (accounts) => {
  describe('gas constraints', () => {
    it('should deploy with less than target deployment gas', async () => {
      const { faucet } = await factory();
      let { gasUsed } = await web3.eth.getTransactionReceipt(faucet.transactionHash);
      assert.isBelow(gasUsed, MAX_DEPLOYMENT_GAS);
      console.log('deployment', gasUsed);
    });
    it('should claim with less than target mutation gas', async () => {
      const [a1] = accounts;
      const tokenId = TOKENS[0];
      const { nft, faucet, token } = await factory();

      await token.mintTo(faucet.address, BN(100000));
      await simpleMint(nft, tokenId);

      await setNetworkTime('2021-03-30'); // 1 day later
      const resp = await faucet.claim([{ tokenId, amount: BN(1000), to: a1, reclaimBps: 0 }]);
      assert.isBelow(resp.receipt.gasUsed, MAX_MUTATION_GAS);
      console.log('claim', resp.receipt.gasUsed);
    });
  });
  describe('tokenBalance', () => {
    it('should return a balance for minted tokens', async () => {
      const { nft, faucet } = await factory();
      const tokenId = TOKENS[0];
      await simpleMint(nft, tokenId);
      assert.equal(await faucet.tokenBalance(tokenId), 0);

      await setNetworkTime('2021-03-30'); // 1 day later
      assert.equal(await faucet.tokenBalance(tokenId), BN(1000));

      await setNetworkTime('2021-03-31'); // 1 day later
      assert.equal(await faucet.tokenBalance(tokenId), BN(2000));
    });
    it('should revert with a bad tokenId', async () => {
      const { faucet } = await factory();
      const tokenId = '0x123';
      const task = faucet.tokenBalance(tokenId);
      await truffleAssert.fails(task, truffleAssert.ErrorType.REVERT, 'nonexistent token');
    });
    it('should return max allowed balance if token has mined max', async () => {
      const tokenId = TOKENS[0];
      const { nft, faucet } = await factory();

      await simpleMint(nft, tokenId);
      await setNetworkTime('2022-03-29'); // 1 year later
      assert.equal(await faucet.tokenBalance(tokenId), BN(10000));
    });
  });
  describe('ownerBalance', () => {
    it('should compute owner balance', async () => {
      const [a1] = accounts;
      const { nft, faucet } = await factory();
      const tokenId1 = TOKENS[0];
      const tokenId2 = TOKENS[1];
      await simpleMint(nft, tokenId1);

      await setNetworkTime('2021-05-01'); // token 2 mint date
      await nft.mint({ tokenId: tokenId2, metadataCIDs: ['cid'] });

      await setNetworkTime('2021-05-02'); // 1 day layer
      assert.equal(await faucet.ownerBalance(a1), BN(1000 + 10000 /* 1 day + max */));
    });
  });
  describe('claim', () => {
    it('should claim tokens', async () => {
      const [a1] = accounts;
      const tokenId = TOKENS[0];
      const { nft, faucet, token } = await factory();

      await token.mintTo(faucet.address, BN(100000));
      await simpleMint(nft, tokenId);

      await setNetworkTime('2021-03-30'); // 1 day later
      await faucet.claim([{ tokenId, amount: BN(1000), to: a1, reclaimBps: 0 }]);
      assert.equal(await token.balanceOf(a1), BN(1000));
      assert.equal(await faucet.tokenBalance(tokenId), 0);
      assert.equal(await faucet.reserveBalance(), BN(99000));

      await setNetworkTime('2021-03-31'); // 1 day later
      await faucet.claim([{ tokenId, amount: BN(1000), to: a1, reclaimBps: 0 }]);
      assert.equal(await token.balanceOf(a1), BN(2000));
      assert.equal(await faucet.tokenBalance(tokenId), 0);
      assert.equal(await faucet.reserveBalance(), BN(98000));
    });
    it('should factor in reclaim bps', async () => {
      const [a1] = accounts;
      const tokenId = TOKENS[0];
      const { nft, faucet, token } = await factory();

      await token.mintTo(faucet.address, BN(100000));
      await simpleMint(nft, tokenId);

      await setNetworkTime('2021-03-30'); // 1 day later
      await faucet.claim([{ tokenId, amount: BN(1000), to: a1, reclaimBps: 5000 /* 50% */ }]);
      assert.equal(await token.balanceOf(a1), BN(500));
      assert.equal(await faucet.tokenBalance(tokenId), 0); // token should be fully farmed out still
      assert.equal(await faucet.reserveBalance(), BN(99500) /* faucet balance decreased */);

      await setNetworkTime('2021-03-31'); // 1 day later
      await faucet.claim([{ tokenId, amount: BN(1000), to: a1, reclaimBps: 10000 /* 100% */ }]);
      assert.equal(await token.balanceOf(a1), BN(500));
      assert.equal(await faucet.tokenBalance(tokenId), 0); // token should be fully farmed out still
      assert.equal(await faucet.reserveBalance(), BN(99500) /* reserve balance not impacted */);
    });
    it('should not allow claiming for non owned tokens', async () => {
      const [, a2] = accounts;
      const tokenId = TOKENS[0];
      const { nft, faucet } = await factory();
      await simpleMint(nft, tokenId);
      const task = faucet.claim([{ tokenId, amount: BN(10), to: a2, reclaimBps: 0 }], { from: a2 });
      await truffleAssert.fails(task, truffleAssert.ErrorType.REVERT, 'not token owner');
    });
    it('should let CLAIMER role claim', async () => {
      const [, a2] = accounts;
      const tokenId = TOKENS[0];
      const { nft, faucet, token } = await factory();
      await token.mintTo(faucet.address, BN(100000));
      await faucet.grantRole(await faucet.CLAIMER_ROLE(), a2);

      await simpleMint(nft, tokenId);
      await setNetworkTime('2021-03-30'); // 1 day later
      await faucet.claim([{ tokenId, amount: BN(1000), to: a2, reclaimBps: 0 }], { from: a2 });
      // doesnt throw
    });
    it('should revert with invalid reclaim bps', async () => {
      const [a1] = accounts;
      const { nft, faucet } = await factory();
      const tokenId = TOKENS[0];
      await simpleMint(nft, tokenId);
      const task = faucet.claim([{ tokenId, amount: BN(10), to: a1, reclaimBps: 50000 }]);
      await truffleAssert.fails(task, truffleAssert.ErrorType.REVERT, 'invalid reclaimBps');
    });
    it('should revert with too low reclaim bps', async () => {
      const [a1] = accounts;
      const { nft, faucet } = await factory();
      const tokenId = TOKENS[0];
      await faucet.setMinReclaimBps(1000); // 10%
      await simpleMint(nft, tokenId);
      const task = faucet.claim([{ tokenId, amount: BN(10), to: a1, reclaimBps: 0 }]);
      await truffleAssert.fails(task, truffleAssert.ErrorType.REVERT, 'reclaimBps too low');
    });
    it('should revert when claim amount is 0', async () => {
      const [a1] = accounts;
      const tokenId = TOKENS[0];
      const { nft, faucet, token } = await factory();
      await token.mintTo(faucet.address, BN(100000));

      await simpleMint(nft, tokenId);
      await setNetworkTime('2021-03-30'); // 1 day later
      const task = faucet.claim([{ tokenId, amount: 0, to: a1, reclaimBps: 0 }]);
      await truffleAssert.fails(task, truffleAssert.ErrorType.REVERT, 'invalid amount');
    });
    it('should revert when claim amount is greater than max claim', async () => {
      const [a1] = accounts;
      const tokenId = TOKENS[0];
      const { nft, faucet, token } = await factory();
      await token.mintTo(faucet.address, BN(100000));

      await simpleMint(nft, tokenId);
      await setNetworkTime('2021-03-30'); // 1 day later
      const task = faucet.claim([{ tokenId, amount: BN(11000), to: a1, reclaimBps: 0 }]);
      await truffleAssert.fails(task, truffleAssert.ErrorType.REVERT, 'invalid amount');
    });
    it('should revert when attempting to claim too much', async () => {
      const [a1] = accounts;
      const tokenId = TOKENS[0];
      const { nft, faucet, token } = await factory();
      await token.mintTo(faucet.address, BN(100000));

      await simpleMint(nft, tokenId);
      await setNetworkTime('2021-03-30'); // 1 day later
      const task = faucet.claim([{ tokenId, amount: BN(2000), to: a1, reclaimBps: 0 }]);
      await truffleAssert.fails(task, truffleAssert.ErrorType.REVERT, 'not enough claimable');
    });
    it('should revert if token is locked and attempting to claim', async () => {
      const [a1] = accounts;
      const tokenId = TOKENS[0];
      const { nft, faucet, token, lock } = await factory();
      await token.mintTo(faucet.address, BN(100000));

      await simpleMint(nft, tokenId);
      await lock.lockToken(tokenId);
      await setNetworkTime('2021-03-30'); // 1 day later
      const task = faucet.claim([{ tokenId, amount: BN(1000), to: a1, reclaimBps: 0 }]);
      await truffleAssert.fails(task, truffleAssert.ErrorType.REVERT, 'token is locked');
    });
  });
  describe('access control', () => {
    it('should require DEFAULT_ADMIN_ROLE for setBaseDailyRate', async () => {
      const [, a2] = accounts;
      const { faucet } = await factory();
      const task = faucet.setBaseDailyRate(100, { from: a2 });
      await truffleAssert.fails(task, truffleAssert.ErrorType.REVERT, 'requires DEFAULT_ADMIN_ROLE');
      await faucet.grantRole(await faucet.DEFAULT_ADMIN_ROLE(), a2);
      await faucet.setBaseDailyRate(100, { from: a2 }); // no revert
    });
    it('should require DEFAULT_ADMIN_ROLE for setMaxClaimAllowed', async () => {
      const [, a2] = accounts;
      const { faucet } = await factory();
      const task = faucet.setMaxClaimAllowed(100, { from: a2 });
      await truffleAssert.fails(task, truffleAssert.ErrorType.REVERT, 'requires DEFAULT_ADMIN_ROLE');
      await faucet.grantRole(await faucet.DEFAULT_ADMIN_ROLE(), a2);
      await faucet.setMaxClaimAllowed(100, { from: a2 }); // no revert
    });
    it('should require DEFAULT_ADMIN_ROLE for setMinReclaimBps', async () => {
      const [, a2] = accounts;
      const { faucet } = await factory();
      const task = faucet.setMinReclaimBps(100, { from: a2 });
      await truffleAssert.fails(task, truffleAssert.ErrorType.REVERT, 'requires DEFAULT_ADMIN_ROLE');
      await faucet.grantRole(await faucet.DEFAULT_ADMIN_ROLE(), a2);
      await faucet.setMinReclaimBps(100, { from: a2 }); // no revert
    });
    it('should require DEFAULT_ADMIN_ROLE for setLockManager', async () => {
      const [, a2] = accounts;
      const { faucet } = await factory();
      const { lock } = await factory();
      const task = faucet.setLockManager(lock.address, { from: a2 });
      await truffleAssert.fails(task, truffleAssert.ErrorType.REVERT, 'requires DEFAULT_ADMIN_ROLE');
      await faucet.grantRole(await faucet.DEFAULT_ADMIN_ROLE(), a2);
      await faucet.setLockManager(lock.address, { from: a2 }); // no revert
    });
  });
  describe('admin', () => {
    it('should require reclaim bps <= 10000', async () => {
      const { faucet } = await factory();
      await faucet.setMinReclaimBps(0); // no revert
      await faucet.setMinReclaimBps(10000); // no revert
      const task = faucet.setMinReclaimBps(10001);
      await truffleAssert.fails(task, truffleAssert.ErrorType.REVERT, 'invalid bps');
    });
    it('should config as expected', async () => {
      const { faucet } = await factory();
      const { lock } = await factory();
      await faucet.setMaxClaimAllowed(123);
      await faucet.setBaseDailyRate(456);
      await faucet.setMinReclaimBps(789);
      await faucet.setLockManager(lock.address);
      const config = await faucet.getFaucetConfig();
      assert.equal(config.maxClaimAllowed, 123);
      assert.equal(config.baseDailyRate, 456);
      assert.equal(config.minReclaimBps, 789);
      assert.equal(config.lock, lock.address);
    });
  });
});
