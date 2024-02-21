import { expect } from "chai"

import { ethers, waffle } from "hardhat"
import { createSnapshot, restoreSnapshot } from "./helpers/snapshots"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber } from "ethers";

import { SwapObjects } from "./helpers/types"
import { clearNextOrderId,
         Swap,
         SwapManager,
         getCurrOrderId,
         getNextOrderId,
         VaultTwammPoolAPIHelper} from "./helpers/vaultTwammPoolAPIHelper"
import { PoolModel } from "./model_v2/vaultTwammPool"
import { dumpOrder,
         expectFailure,
         scaleUp,
         getLastBlockNumber,
         mineBlocks,
         dumpContractAccounting,
         ZERO } from "./helpers/misc"      
import { PoolType } from "../scripts/utils/contractMgmt"

import { deployCommonContracts } from './common';

// Logging:
const ds = require("../scripts/utils/debugScopes");
const log = ds.getLog("twault-pause-resume-posneg");

// Equal initial liquidity for both token 0 & 1 of 10k tokens (accounting for 18 decimals).
const TOKEN0_DECIMALS = 18;
const TOKEN1_DECIMALS = 18;
const INITIAL_LIQUIDITY_0 = scaleUp(10_000n, TOKEN0_DECIMALS);
const INITIAL_LIQUIDITY_1 = scaleUp(10_000n, TOKEN1_DECIMALS);


describe("TWAULT (TWAMM Balancer Vault) Pause / Resume Positive & Negative Suite", function ()
{
  let owner: SignerWithAddress,
      addr1: SignerWithAddress,
      addr2: SignerWithAddress,
      addr3: SignerWithAddress,
      admin1: SignerWithAddress,
      admin2: SignerWithAddress,
      partnerBloxRoute: SignerWithAddress,
      partnerX: SignerWithAddress,
      arbitrageur1: SignerWithAddress,
      arbitrageur2: SignerWithAddress,
      arbitrageur3: SignerWithAddress,
      arbitrageur4: SignerWithAddress,
      arbitrageur5: SignerWithAddress,
      feeAddr1: SignerWithAddress,
      feeAddr2: SignerWithAddress,
      addrs: SignerWithAddress[];

  let poolHelper: VaultTwammPoolAPIHelper;
  let swapMgr: SwapManager;

  let poolModel: PoolModel;
    
  // Contracts for testing into local vars:
  let token0AssetContract: any;
  let token1AssetContract: any;
  let balancerVaultContract: any;
  let poolContract: any;
  let arbitrageListContract: any;
  let arbitrageListContract2: any;

  let BLOCK_INTERVAL: number


  before(async function () 
  {
    clearNextOrderId()
    await createSnapshot(waffle.provider);
    const result = await deployCommonContracts(PoolType.Stable);
    BLOCK_INTERVAL = result.BLOCK_INTERVAL
    owner = result.owner;
    addr1 = result.addr1
    addr2 = result.addr2
    addr3 = result.addr3
    admin1 = result.admin1
    admin2 = result.admin2
    partnerBloxRoute = result.partnerBloxRoute
    partnerX = result.partnerX,
    arbitrageur1 = result.arbitrageur1
    arbitrageur2 = result.arbitrageur2
    arbitrageur3 = result.arbitrageur3
    arbitrageur4 = result.arbitrageur4
    arbitrageur5 = result.arbitrageur5
    feeAddr1 = result.feeAddr1
    feeAddr2 = result.feeAddr2
    addrs = result.addrs
    poolHelper = result.poolHelper
    swapMgr = result.swapMgr
    poolModel = result.poolModel
    token0AssetContract = result.token0AssetContract
    token1AssetContract = result.token1AssetContract
    balancerVaultContract = result.balancerVaultContract
    poolContract = result.poolContract
    arbitrageListContract = result.arbitrageListContract
    arbitrageListContract2 = result.arbitrageListContract2
  })


  after(function () {
    restoreSnapshot(waffle.provider);
  })


  // NOTE - UGLY:
  // --------------------------------------------------------------------------------
  // Unfortunately the expect mechanism for reverted with is not working
  // (possibly b/c external functions or something else). Anyway, the code below 
  // uses try/catch to examine failures in the receipts. Unfortunately it cannot 
  // examine the receipt for specific errors (i.e. CFI#008).
  //
  // TODO: When time, figure out why and extend to analyze particular error.
  //


  describe("Pause Negative Tests", function() {

    // Variables for use in this series of tests:
    //
    const intervals = 1   // The contract adds 1 to this
    const swapAmt2k = scaleUp(2_000n, TOKEN0_DECIMALS)
    let swap1: Swap
    let swapObjects1: SwapObjects
    let orderId1: number
    let swap2: Swap
    let swapObjects2: SwapObjects
    let orderId2: number
    const testAddrs: { [index: string]: SignerWithAddress } = {}


    it ("should be configured with liquidity", async function() {
      testAddrs.lp = addr3
      testAddrs.owner = addr1
      testAddrs.delegate = addr2

      // Add liquidity:
      //
      await token0AssetContract.connect(owner).transfer(testAddrs.lp.address, INITIAL_LIQUIDITY_0);
      await token1AssetContract.connect(owner).transfer(testAddrs.lp.address, INITIAL_LIQUIDITY_1);
      let joinObjects = await poolHelper.getJoinObjects( INITIAL_LIQUIDITY_0, INITIAL_LIQUIDITY_1 );
      await token0AssetContract.connect(testAddrs.lp).approve(balancerVaultContract.address, joinObjects.token0Amt);
      await token1AssetContract.connect(testAddrs.lp).approve(balancerVaultContract.address, joinObjects.token1Amt);
      await mineBlocks();

      //
      // Provide initial liquidity:
      await balancerVaultContract.connect(testAddrs.lp).joinPool(
        poolHelper.getPoolId(),
        testAddrs.lp.address,
        testAddrs.lp.address,
        joinObjects.joinStruct
      )
      await mineBlocks();

      const lpSupply = await poolContract.totalSupply()
      expect(lpSupply, 'Pool should have LP tokens').to.be.gt(ZERO)
    })


    it ("should not allow pause of a non-existent order", async function () {
      const NON_EXISTANT_ORDER_ID = 255

      const txn = await poolContract
                        .connect(addr1)
                        .pauseOrder(NON_EXISTANT_ORDER_ID)
      await mineBlocks();

      // The order doesn't exist which means that the pauseOrder method will
      // fail the sender not owner or delegate check:
      await expectFailure(txn, 'Pause non-existent order.', 'CFI#008')
    })


    it ("should not allow pause of another account's unpaused order", async function () {
      swap1 = swapMgr.newSwap0To1()
      swapObjects1 = await swap1.longTerm(
        swapAmt2k,
        intervals,
        testAddrs.owner,
        true,   /* doSwap */
        true,   /* doApprovals */
        testAddrs.delegate 
      )

      await mineBlocks(10)


      // Check that order exists and is not paused:
      //
      orderId1 = swap1.getOrderId()
      const orderInfo = await poolContract.connect(testAddrs.owner).getOrder(orderId1)
      expect(orderInfo.owner).to.eq(testAddrs.owner.address)
      expect(orderInfo.delegate).to.eq(testAddrs.delegate.address)
      expect(orderInfo.paused).to.eq(false)


      // Now try to pause the order as the non-owner, non-delegate:
      //
      const txn = await poolContract
                        .connect(addr3)
                        .pauseOrder(orderId1)
      await mineBlocks();

      // The order is not related to addr3 meaning the pauseOrder method will
      // fail the sender not owner or delegate check:
      await expectFailure(txn, 'Pause another account\'s unpaused order.', 'CFI#008')
    })


    it ("should not allow pause of another account's paused order", async function () {
      // Pause the order:
      //
      await poolContract
            .connect(testAddrs.owner)
            .pauseOrder(orderId1)
      await mineBlocks();

      // Check that order is paused:
      //
      const orderInfo = await poolContract.connect(testAddrs.owner).getOrder(orderId1)
      expect(orderInfo.paused).to.eq(true)

      // Now try to pause the order as the non-owner, non-delegate:
      //
      const txn = await poolContract
                        .connect(addr3)
                        .pauseOrder(orderId1)
      await mineBlocks();

      // The order is not related to addr3 meaning the pauseOrder method will
      // fail the sender not owner or delegate check:
      //
      await expectFailure(txn, 'Pause another account\'s paused order.', 'CFI#008')
    })


    it ("should not allow pause of an already paused order", async function () {
      // Check that order is already paused and that the owner/delegate
      // addresses are correct:
      //
      const orderInfo = await poolContract.connect(addr1).getOrder(orderId1)
      expect(orderInfo.paused).to.eq(true)

      // Now try to pause the order as both the owner and delegate:
      //
      for (const key in testAddrs) {
        if (key === 'lp') {
          continue
        }
        const txn = await poolContract
                          .connect(testAddrs[key])
                          .pauseOrder(orderId1)
        await mineBlocks()

        // The order is already paused and the transaction should revert.
        //
        await expectFailure(txn, `Pause an already paused order (${key}).`, 'CFI#231')
      }
    })


    it ("should not allow pause of an expired unpaused order", async function () {
      // Unpause the order:
      //
      await poolContract
            .connect(testAddrs.owner)
            .resumeOrder(orderId1)
      await mineBlocks()

      // Confirm the order is unpaused:
      //
      const orderInfo = await poolContract.connect(testAddrs.owner).getOrder(orderId1)
      expect(orderInfo.paused).to.eq(false)

      // Mine blocks to the order expiry
      //
      const blockNumber = await getLastBlockNumber()
      const expiryBlock = orderInfo.orderExpiry
      const blocksToMine = expiryBlock - blockNumber
      await mineBlocks(blocksToMine)

      // Now try to pause the order as both owner and delegate:
      //
      for (const key in testAddrs) {
        if (key === 'lp') {
          continue
        }
        const txn = await poolContract
                          .connect(testAddrs[key])
                          .pauseOrder(orderId1)
        await mineBlocks()

        // The order is expired and the transaction should revert.
        //
        await expectFailure(txn, `Pause an expired unpaused order (${key}).`, 'CFI#229')
      }
    })


    it ("should not allow pause of an expired paused order", async function () {
      // Issue a new order and mine a few blocks
      //
      swap2 = swapMgr.newSwap1To0()
      swapObjects2 = await swap2.longTerm(
        swapAmt2k,
        intervals,
        testAddrs.owner,
        true,   /* doSwap */
        true,   /* doApprovals */
        testAddrs.delegate 
      )

      await mineBlocks(2)
      
      // Check that order exists and is not paused:
      //
      orderId2 = swap2.getOrderId()
      let orderInfo = await poolContract.connect(testAddrs.owner).getOrder(orderId2)
      expect(orderInfo.owner).to.eq(testAddrs.owner.address)
      expect(orderInfo.delegate).to.eq(testAddrs.delegate.address)
      expect(orderInfo.paused).to.eq(false)
      expect(orderInfo.token0To1).to.eq(false)

      // Pause the order
      //
      const txn = await poolContract
                        .connect(testAddrs.owner)
                        .pauseOrder(orderId2)
      await mineBlocks();

      // Confirm the order is paused and mine to expiry
      //
      orderInfo = await poolContract.connect(testAddrs.owner).getOrder(orderId2)
      expect(orderInfo.paused).to.eq(true)
      
      const blockNumber = await getLastBlockNumber()
      const expiryBlock = orderInfo.orderExpiry
      const blocksToMine = expiryBlock - blockNumber
      await mineBlocks(blocksToMine)

      // Now try to pause the order as both owner and delegate:
      //
      for (const key in testAddrs) {
        if (key === 'lp') {
          continue
        }
        const txn = await poolContract
                          .connect(testAddrs[key])
                          .pauseOrder(orderId2)
        await mineBlocks()

        // The order is already paused and the transaction should revert.
        //
        await expectFailure(txn, `Pause an expired unpaused order (${key}).`, 'CFI#231')
      }
    })

    it ("should not allow pause of a completed, paused, withdrawn order", async function () {
      // Check that the order is completed and paused:
      //
      let orderInfo = await poolContract.connect(testAddrs.owner).getOrder(orderId2)
      expect(orderInfo.paused).to.eq(true)
      
      const expiryBlock = orderInfo.orderExpiry
      const blockNumber = await getLastBlockNumber()
      expect(expiryBlock, 'Order expired').to.be.lt(blockNumber)

      // Capture the owner's Token 0 balance before withdraw:
      //
      const t0Before = await token0AssetContract.balanceOf(testAddrs.owner.address)

      // Withdraw the order:
      //
      await swap2.withdrawLongTerm()
      
      // Check that the withdraw changed the owner balance:
      //   - orderId2 is from Token 1 to Token 0 so we expect the owner's
      //     balance to increase by slightly less than 2k Token 0 (slippage,
      //     fees, etc.)
      //
      const t0After= await token0AssetContract.balanceOf(testAddrs.owner.address)
      const t0Change = t0After.sub(t0Before)
      expect(t0Change, 'Owner should get some T0 from trade.').to.be.gt(ZERO)

      // Now try to pause the order as both owner and delegate; expect failure.
      // The final withdraw should have cleared the order entirely, so it should
      // fail the check that the address is the owner/delegate (or null).
      // (if could check CFI#008)
      //
      for (const key in testAddrs) {
        if (key === 'lp') {
          continue
        }
        const txn = await poolContract
                          .connect(testAddrs[key])
                          .pauseOrder(orderId2)
        await mineBlocks()

        // The order is already withdrawn and the transaction should revert.
        //
        await expectFailure(txn, `Pause an expired paused withdrawn order (${key}).`, 'CFI#008')
      }
    })

    it ("should not allow pause of a completed, unpaused, withdrawn order", async function () {
      // Check that the order is completed and unpaused:
      //
      let orderInfo = await poolContract.connect(testAddrs.owner).getOrder(orderId1)
      expect(orderInfo.paused).to.eq(false)
      
      const expiryBlock = orderInfo.orderExpiry
      const blockNumber = await getLastBlockNumber()
      expect(expiryBlock, 'Order expired').to.be.lt(blockNumber)

      // Capture the owner's Token 1 balance before withdraw:
      //
      const t1Before = await token1AssetContract.balanceOf(testAddrs.owner.address)

      // Withdraw the order:
      //
      await swap1.withdrawLongTerm()

      // Check that the withdraw changed the owner balance:
      //
      const t1After= await token1AssetContract.balanceOf(testAddrs.owner.address)
      const t1Change = t1After.sub(t1Before)
      expect(t1Change, 'Owner should get some T1 from trade.').to.be.gt(ZERO)

      // Now try to pause the order as both owner and delegate; expect failure.
      // The final withdraw should have cleared the order entirely, so it should
      // fail the check that the address is the owner/delegate (or null).
      //
      for (const key in testAddrs) {
        if (key === 'lp') {
          continue
        }
        const txn = await poolContract
                          .connect(testAddrs[key])
                          .pauseOrder(orderId1)
        await mineBlocks()

        // The order is already withdrawn and the transaction should revert.
        //
        await expectFailure(txn, `Pause an expired unpaused withdrawn order (${key}).`, 'CFI#008')
      }
    })

    it ("should not allow pause of an unpaused (active), cancelled order", async function () {
      // Issue an order 
      //
      const swapToCancel = swapMgr.newSwap0To1()
      const stcObjects = await swapToCancel.longTerm(
        swapAmt2k, 
        intervals, 
        testAddrs.owner,
        true,   /* doSwap */
        true,   /* doApprovals */
        testAddrs.delegate)

      // Mine a few blocks, then cancel the order
      //
      await mineBlocks(10)

      // Check the order exists and is not paused:
      //
      const orderId3 = swapToCancel.getOrderId()
      let orderInfo = await poolContract.connect(testAddrs.owner).getOrder(orderId3)
      expect(orderInfo.owner).to.eq(testAddrs.owner.address)
      expect(orderInfo.delegate).to.eq(testAddrs.delegate.address)
      expect(orderInfo.paused).to.eq(false)
      expect(orderInfo.token0To1).to.eq(true)

      // Cancel the order:
      //
      await swapToCancel.cancelLongTerm()
      await mineBlocks()

      // Now try to pause the order as both owner and delegate; expect failure.
      // The final withdraw should have cleared the order entirely, so it should
      // fail the check that the address is the owner/delegate (or null).
      //
      for (const key in testAddrs) {
        const txn = await poolContract
                          .connect(testAddrs[key])
                          .pauseOrder(orderId3)
        await mineBlocks()

        // The order is cancelled and the transaction should revert.
        //
        await expectFailure(txn, `Pause an unpaused (active), cancelled order (${key}).`, 'CFI#008')
      }
    })

    it ("should not allow pause of a paused, cancelled order", async function () {
      // Issue an order 
      //
      const swapToCancel = swapMgr.newSwap1To0()
      const stcObjects = await swapToCancel.longTerm(
        swapAmt2k, 
        intervals, 
        testAddrs.owner,
        true,   /* doSwap */
        true,   /* doApprovals */
        testAddrs.delegate)

      // Mine a few blocks, then cancel the order
      //
      await mineBlocks(10)

      // Check the order exists and is not paused:
      //
      const orderId4 = swapToCancel.getOrderId()
      let orderInfo = await poolContract.connect(testAddrs.owner).getOrder(orderId4)
      expect(orderInfo.owner).to.eq(testAddrs.owner.address)
      expect(orderInfo.delegate).to.eq(testAddrs.delegate.address)
      expect(orderInfo.paused).to.eq(false)
      expect(orderInfo.token0To1).to.eq(false)

      // Pause the order:
      //
      await poolContract.connect(testAddrs.owner).pauseOrder(orderId4)
      await mineBlocks()

      // Check the order is paused:
      //
      orderInfo = await poolContract.connect(testAddrs.owner).getOrder(orderId4)
      expect(orderInfo.paused).to.eq(true)

      // Cancel the order:
      //
      await swapToCancel.cancelLongTerm()
      await mineBlocks()

      // Now try to pause the order as both owner and delegate; expect failure.
      // The final withdraw should have cleared the order entirely, so it should
      // fail the check that the address is the owner/delegate (or null).
      //
      for (const key in testAddrs) {
        const txn = await poolContract
                          .connect(testAddrs[key])
                          .pauseOrder(orderId4)
        await mineBlocks()

        // The order is already cancelled and the transaction should revert.
        //
        await expectFailure(txn, `Pause an unpaused (active), cancelled order (${key}).`, 'CFI#008')
      }
    })
  })
  
  describe("Resume Negative Tests", function() {
    // Variables for use in this series of tests:
    //
    const intervals = 1   // The contract adds 1 to this
    const swapAmt2k = scaleUp(2_000n, TOKEN0_DECIMALS)
    let swap1: Swap
    let swapObjects1: SwapObjects
    let swap2: Swap
    let swapObjects2: SwapObjects
    const testAddrs: { [index: string]: SignerWithAddress } = {}

    it ("should not allow resume of a non-existant order", async function () {
      const NON_EXISTANT_ORDER_ID = getCurrOrderId() + 1
      const txn = await poolContract
                        .connect(addr1)
                        .resumeOrder(NON_EXISTANT_ORDER_ID)
      await mineBlocks()

      // The order doesn't exist which means that the resumeOrder method will
      // fail the sender not owner or delegate check:
      //
      await expectFailure(txn, 'Resume non-existent order.', 'CFI#008')
    })

    it ("should not allow resume of another account's paused order", async function () {
      // Configure test addresses:
      //
      testAddrs.lp = addr3
      testAddrs.owner = addr1
      testAddrs.delegate = addr2

      // Issue a new LT order:
      //
      swap1 = swapMgr.newSwap0To1()
      swapObjects1 = await swap1.longTerm(
        swapAmt2k,
        intervals,
        testAddrs.owner,
        true,   /* doSwap */
        true,   /* doApprovals */
        testAddrs.delegate
      )

      // Mine a few blocks and then pause the order:
      //
      const orderId = swap1.getOrderId()
      await mineBlocks(10)
      await poolContract.connect(testAddrs.owner).pauseOrder(orderId)
      await mineBlocks()

      // Confirm the order is paused:
      //
      const orderInfo = await poolContract.connect(testAddrs.owner).getOrder(orderId)
      expect(orderInfo.paused).to.eq(true)

      // Now try to resume the order as the non-owner, non-delegate:
      //
      const txn = await poolContract.connect(testAddrs.lp).resumeOrder(orderId)
      await mineBlocks()

      // The order is not related to the lp test address and the resumeOrder method 
      // will fail the "sender not owner or delegate check":
      //
      await expectFailure(txn, 'Resume another account\'s paused order.', 'CFI#008')
    })

    it ("should not allow resume of another account's unpaused order", async function () {
      // Now unpause the order from the last test:
      //
      const orderId = swap1.getOrderId()
      await poolContract.connect(testAddrs.owner).resumeOrder(orderId)
      await mineBlocks()

      // Confirm the order is active (unpaused):
      //
      const orderInfo = await poolContract.connect(testAddrs.owner).getOrder(orderId)
      expect(orderInfo.paused).to.eq(false)

      // Now try to resume the order as the non-owner, non-delegate:
      //
      const txn = await poolContract.connect(testAddrs.lp).resumeOrder(orderId)
      await mineBlocks()

      // The order is not related to the lp test address and the resumeOrder method 
      // will fail the "sender not owner or delegate check":
      //
      await expectFailure(txn, 'Resume another account\'s paused order.', 'CFI#008')
    })
    
    it ("should not allow resume of an active, never paused, order", async function () {
      // Create a new order that has yet to be paused:
      //
      swap2 = swapMgr.newSwap1To0()
      swapObjects2 = await swap2.longTerm(
        swapAmt2k,
        intervals,
        testAddrs.owner,
        true,   /* doSwap */
        true,   /* doApprovals */
        testAddrs.delegate
      )

      // Mine a few blocks and confirm the order is active:
      //
      await mineBlocks(10)
      const orderId = swap2.getOrderId()
      const orderInfo = await poolContract.connect(testAddrs.owner).getOrder(orderId)
      expect(orderInfo.paused).to.eq(false)

      // Now try to resume the already active order as the owner and delegate:
      //
      for (const key in testAddrs) {
        if (key === 'lp') {
          continue
        }
        const txn = await poolContract
                          .connect(testAddrs[key])
                          .resumeOrder(orderId)
        await mineBlocks()

        // The order is already active (never paused) and the transaction should revert.
        //
        await expectFailure(txn, `Resume an already active order (${key}).`, 'CFI#232')
      }
    })
    
    it ("should not allow resume of an active (resumed) order", async function () {
      // Confirm that the first order is active (the order that was already 
      // paused and then resumed in tests above--swap1):
      //
      const orderId = swap1.getOrderId()
      const orderInfo = await poolContract.connect(testAddrs.owner).getOrder(orderId)
      expect(orderInfo.paused).to.eq(false)

      // Now try to resume the already active order as the owner and delegate:
      //
      for (const key in testAddrs) {
        if (key === 'lp') {
          continue
        }
        const txn = await poolContract
                          .connect(testAddrs[key])
                          .resumeOrder(orderId)
        await mineBlocks()

        // The order is already resumed and the transaction should revert.
        //
        await expectFailure(txn, `Resume an already active order (${key}).`, 'CFI#232')
      }
    })
    
    it ("should not allow resume of an expired paused order", async function () {
      // Pause the first order and then mine until it expires:
      //
      const orderId = swap1.getOrderId()
      await poolContract.connect(testAddrs.owner).pauseOrder(orderId)

      let blockNumber = await getLastBlockNumber()
      let orderInfo = await poolContract.connect(testAddrs.owner).getOrder(orderId)
      const expiryBlock = orderInfo.orderExpiry
      const blocksToMine = expiryBlock - blockNumber
      await mineBlocks(blocksToMine)

      // Mine an extra block to be past expiry:
      //
      await mineBlocks()

      // Confirm the order is paused and expired:
      //
      orderInfo = await poolContract.connect(testAddrs.owner).getOrder(orderId)
      expect(orderInfo.paused).to.eq(true)
      blockNumber = await getLastBlockNumber()
      expect(orderInfo.orderExpiry).to.be.lt(blockNumber)

      // Now try to resume the expired, paused order as the owner and delegate:
      //
      for (const key in testAddrs) {
        const txn = await poolContract
                          .connect(testAddrs[key])
                          .resumeOrder(orderId)
        await mineBlocks()

        // The order is expired and the resume transaction should revert.
        //
        await expectFailure(txn, `Resume an expired, paused order (${key}).`, 'CFI#229')
      }
    })

    it ("should not allow resume of an expired unpaused order", async function () {
      // Confirm the second order is both unpaused and expired:
      //
      const orderId = swap2.getOrderId()
      let orderInfo = await poolContract.connect(testAddrs.owner).getOrder(orderId)
      expect(orderInfo.paused).to.eq(false)

      const blockNumber = await getLastBlockNumber()
      expect(orderInfo.orderExpiry).to.be.lt(blockNumber)

      // Now try to resume the expired, unpaused order as the owner and delegate:
      //
      for (const key in testAddrs) {
        const txn = await poolContract
                          .connect(testAddrs[key])
                          .resumeOrder(orderId)
        await mineBlocks()

        // The order is expired and the resume transaction should revert.
        //
        await expectFailure(txn, `Resume an expired, unpaused order (${key}).`, 'CFI#229')
      }      
    })

    it ("should not allow resume of a completed, paused, withdrawn order", async function () {
      // Confirm the first order is paused and expired:
      //
      const orderId = swap1.getOrderId()
      let orderInfo = await poolContract.connect(testAddrs.owner).getOrder(orderId)
      expect(orderInfo.paused).to.eq(true)
      
      const blockNumber = await getLastBlockNumber()
      expect (orderInfo.orderExpiry).to.be.lt(blockNumber)

      // Withdraw the order and confirm funds to the owner:
      //
      const prevBalT1 = await token1AssetContract.balanceOf(testAddrs.owner.address)
      await swap1.withdrawLongTerm()
      const newBalT1 = await token1AssetContract.balanceOf(testAddrs.owner.address)
      const balChangeT1 = newBalT1.sub(prevBalT1)
      expect(balChangeT1, 'Owner should get some T1 from trade.').to.be.gt(ZERO)

      // Now try to resume the expired, paused, withdrawn order as any address:
      // The final withdraw should have cleared the order entirely, so it should
      // fail the check that the address is the owner/delegate (or null).
      //
      for (const key in testAddrs) {
        const txn = await poolContract
                          .connect(testAddrs[key])
                          .resumeOrder(orderId)
        await mineBlocks()

        // The order is already withdrawn and the transaction should revert.
        //
        await expectFailure(txn, `Pause an expired paused withdrawn order (${key}).`, 'CFI#008')
      }
    })

    it ("should not allow resume of a completed, unpaused, withdrawn order", async function () {
      // Confirm the second order is unpaused and expired:
      //
      const orderId = swap2.getOrderId()
      let orderInfo = await poolContract.connect(testAddrs.owner).getOrder(orderId)
      expect(orderInfo.paused).to.eq(false)
      
      const blockNumber = await getLastBlockNumber()
      expect (orderInfo.orderExpiry).to.be.lt(blockNumber)

      // Withdraw and confirm funds to the owner:
      //
      const prevBalT0 = await token0AssetContract.balanceOf(testAddrs.owner.address)
      await swap2.withdrawLongTerm()
      const newBalT0 = await token0AssetContract.balanceOf(testAddrs.owner.address)
      const balChangeT0 = newBalT0.sub(prevBalT0)
      expect(balChangeT0, 'Owner should get some T0 from trade.').to.be.gt(ZERO)

      // Now try to resume the expired, unpaused, withdrawn order as any address:
      // The final withdraw should have cleared the order entirely, so it should
      // fail the check that the address is the owner/delegate (or null).
      //
      for (const key in testAddrs) {
        const txn = await poolContract
                          .connect(testAddrs[key])
                          .resumeOrder(orderId)
        await mineBlocks()

        // The order is already withdrawn and the transaction should revert.
        //
        await expectFailure(txn, `Pause an expired paused withdrawn order (${key}).`, 'CFI#008')
      }

    })

    it ("should not allow resume of a cancelled, unpaused order", async function () {
      // Issue an order 
      //
      const swapToCancel = swapMgr.newSwap0To1()
      const stcObjects = await swapToCancel.longTerm(
        swapAmt2k, 
        intervals, 
        testAddrs.owner,
        true,   /* doSwap */
        true,   /* doApprovals */
        testAddrs.delegate)

      // Mine a few blocks, then cancel the order
      //
      await mineBlocks(10)

      // Check the order exists and is not paused:
      //
      const orderId = swapToCancel.getOrderId()
      let orderInfo = await poolContract.connect(testAddrs.owner).getOrder(orderId)
      expect(orderInfo.owner).to.eq(testAddrs.owner.address)
      expect(orderInfo.delegate).to.eq(testAddrs.delegate.address)
      expect(orderInfo.paused).to.eq(false)
      expect(orderInfo.token0To1).to.eq(true)

      // Cancel the order:
      //
      await swapToCancel.cancelLongTerm()
      await mineBlocks()

      // Now try to resume the order as any address; expect failure.
      // The final withdraw should have cleared the order entirely, so it should
      // fail the check that the address is the owner/delegate (or null).
      //
      for (const key in testAddrs) {
        const txn = await poolContract
                          .connect(testAddrs[key])
                          .resumeOrder(orderId)
        await mineBlocks()

        // The order is cancelled the transaction should revert.
        //
        await expectFailure(txn, `Resume an unpaused (active), cancelled order (${key}).`, 'CFI#008')
      }
    })
    
    it ("should not allow resume of a cancelled, paused order", async function () {
      // Issue an order 
      //
      const swapToCancel = swapMgr.newSwap1To0()
      const stcObjects = await swapToCancel.longTerm(
        swapAmt2k, 
        intervals, 
        testAddrs.owner,
        true,   /* doSwap */
        true,   /* doApprovals */
        testAddrs.delegate)

      // Mine a few blocks, then cancel the order
      //
      await mineBlocks(10)

      // Check the order exists and is not paused:
      //
      const orderId = swapToCancel.getOrderId()
      let orderInfo = await poolContract.connect(testAddrs.owner).getOrder(orderId)
      expect(orderInfo.owner).to.eq(testAddrs.owner.address)
      expect(orderInfo.delegate).to.eq(testAddrs.delegate.address)
      expect(orderInfo.paused).to.eq(false)
      expect(orderInfo.token0To1).to.eq(false)

      // Pause the order:
      //
      await poolContract.connect(testAddrs.owner).pauseOrder(orderId)
      await mineBlocks()

      // Check the order is paused:
      //
      orderInfo = await poolContract.connect(testAddrs.owner).getOrder(orderId)
      expect(orderInfo.paused).to.eq(true)

      // Cancel the order:
      //
      await swapToCancel.cancelLongTerm()
      await mineBlocks()

      // Now try to pause the order as any address; expect failure.
      // The final withdraw should have cleared the order entirely, so it should
      // fail the check that the address is the owner/delegate (or null).
      //
      for (const key in testAddrs) {
        const txn = await poolContract
                          .connect(testAddrs[key])
                          .resumeOrder(orderId)
        await mineBlocks()

        // The order is already cancelled and the transaction should revert.
        //
        await expectFailure(txn, `Resume a paused, cancelled order (${key}).`, 'CFI#008')
      }
    })
  })

  describe("Misc Negative Tests", function() {
    const testAddrs: { [index: string]: SignerWithAddress } = {}

    it ("should not withdraw a paused order to a non-owner address", async function() {
      testAddrs.lp = addr3
      testAddrs.owner = addr1
      testAddrs.delegate = addr2

      // Issue a new order:
      //
      const swapAmt2k = scaleUp(2_000n, TOKEN0_DECIMALS)
      const swap = swapMgr.newSwap0To1()
      const swapObjects = await swap.longTerm(
        swapAmt2k, 
        2,      /* intervals */
        testAddrs.owner,
        true,   /* doSwap */
        true,   /* doApprovals */
        testAddrs.delegate)

      // Mine a few blocks:
      //
      await mineBlocks(10)

      // Pause the order and confirm:
      //
      const orderId = swap.getOrderId()
      await poolContract
            .connect(addr1)
            .pauseOrder(orderId)
      await mineBlocks()

      const orderInfo = await poolContract.connect(testAddrs.owner).getOrder(orderId)
      expect(orderInfo.paused).to.eq(true)

      // Confirm that you cannot do a withdraw to the non-owner address by any address 
      // but the owner:
      //
      const nonOwnerDestination = testAddrs.delegate
      await expect(swap.withdrawLongTerm(orderId, testAddrs.delegate, nonOwnerDestination))
            .to.be
            .revertedWith('CFI#010')
      
      await expect(swap.withdrawLongTerm(orderId, testAddrs.lp, nonOwnerDestination))
            .to.be
            .revertedWith('CFI#010')
    })
  })

  describe("Positive Tests", function() {
    const testAddrs: { [index: string]: SignerWithAddress } = {}
    let swap: Swap

    // Combined with test "Can resume a paused, unexpired order"
    //
    it ("Can pause an active order", async function() {
      testAddrs.lp = addr3
      testAddrs.owner = addr1
      testAddrs.delegate = addr2

      // Create an order:
      //
      const swapAmt5k = scaleUp(5_000n, TOKEN0_DECIMALS)
      swap = swapMgr.newSwap0To1()
      const swapObjects = await swap.longTerm(
        swapAmt5k, 
        2,      /* intervals */
        testAddrs.owner,
        true,   /* doSwap */
        true,   /* doApprovals */
        testAddrs.delegate)
      
      // Mine a few blocks and confirm it's unpaused
      //
      await mineBlocks()
      const orderId = swap.getOrderId()
      let orderInfo = await poolContract.connect(testAddrs.owner).getOrder(orderId)
      expect(orderInfo.paused).to.eq(false)

      // Loop through users owner and delegate:
      //
      for (const key in testAddrs) {
        if (key === 'lp') {
          continue
        }

        // Pause the order and confirm it's paused
        //
        await poolContract.connect(testAddrs[key]).pauseOrder(orderId)
        await mineBlocks()

        orderInfo = await poolContract.connect(testAddrs.owner).getOrder(orderId)
        expect(orderInfo.paused).to.eq(true)
      
        // Resume the order as the owner and confirm it's unpaused
        //
        await poolContract.connect(testAddrs[key]).resumeOrder(orderId)
        await mineBlocks()
        
        orderInfo = await poolContract.connect(testAddrs.owner).getOrder(orderId)
        expect(orderInfo.paused).to.eq(false)
      }
    })
    
    it ("Can withdraw a paused, unexpired, order", async function() {
      const orderId = swap.getOrderId()

      // Loop through users owner and delegate and perform withdraws,
      // confirming receipt of proceeds and non-expiry status:
      //
      for (const key in testAddrs) {
        if (key === 'lp') {
          continue
        }

        // Pause the order from the previous example:
        //
        await poolContract.connect(testAddrs.owner).pauseOrder(orderId)
        await mineBlocks()

        // Confirm the order is paused and not expired:
        //
        const blockNumber = await getLastBlockNumber()
        const orderInfo = await poolContract.connect(testAddrs.owner).getOrder(orderId)
        expect(orderInfo.paused).to.eq(true)
        expect(orderInfo.orderExpiry).to.be.gt(blockNumber)

        // Withdraw the order, while paused, and confirm the receipt of 
        // proceeds:
        //
        const prevBalT1 = await token1AssetContract.balanceOf(testAddrs.owner.address)
        await swap.withdrawLongTerm(
          orderId,
          testAddrs[key],   // message sender
          testAddrs.owner   // funds recipient
        )
        const currBalT1 = await token1AssetContract.balanceOf(testAddrs.owner.address)
        expect(currBalT1, 'Withdraw should increase owner\'s T1 balance').to.be.gt(prevBalT1)

        // Unpause the order and mine a few more blocks to get more proceeds
        // for the next loop iteration:
        //
        await poolContract.connect(testAddrs.owner).resumeOrder(orderId)
        await mineBlocks(10)
      }

      // Variant - withdraw as the owner, but to a different address:
      //
      {
        // Pause the order from the previous example:
        //
        await poolContract.connect(testAddrs.owner).pauseOrder(orderId)
        await mineBlocks()

        // Confirm the order is paused and not expired:
        //
        const blockNumber = await getLastBlockNumber()
        const orderInfo = await poolContract.connect(testAddrs.owner).getOrder(orderId)
        expect(orderInfo.paused).to.eq(true)
        expect(orderInfo.orderExpiry).to.be.gt(blockNumber)

        // Withdraw the order, while paused, and confirm the receipt of 
        // proceeds:
        //
        const prevBalT1 = await token1AssetContract.balanceOf(testAddrs.delegate.address)
        await swap.withdrawLongTerm(
          orderId,
          testAddrs.owner,   // message sender
          testAddrs.delegate// funds recipient
        )
        const currBalT1 = await token1AssetContract.balanceOf(testAddrs.delegate.address)
        expect(currBalT1, 'Withdraw should increase delegate\'s T1 balance').to.be.gt(prevBalT1)
      }
    })

    it ("Can cancel a paused, unexpired, order", async function() {
      // Create two orders:
      //
      const swapAmt5k = scaleUp(5_000n, TOKEN0_DECIMALS)

      const swap1 = swapMgr.newSwap0To1()
      const swapObjects1 = await swap1.longTerm(
        swapAmt5k, 
        1,          // intervals
        testAddrs.owner,
        true,   /* doSwap */
        true,   /* doApprovals */
        testAddrs.delegate
      )

      const swap2 = swapMgr.newSwap1To0()
      const swapObjects2 = await swap2.longTerm(
        swapAmt5k, 
        1,          // intervals
        testAddrs.owner,
        true,   /* doSwap */
        true,   /* doApprovals */
        testAddrs.delegate
      )

      // Mine a few blocks, then pause both orders and confirm paused status:
      //
      await mineBlocks(10)

      const orderId1 = swap1.getOrderId()
      await poolContract.connect(testAddrs.owner).pauseOrder(orderId1)

      const orderId2 = swap2.getOrderId()
      await poolContract.connect(testAddrs.owner).pauseOrder(orderId2)

      await mineBlocks()

      const orderInfo1 = await poolContract.connect(testAddrs.owner).getOrder(orderId1)
      expect(orderInfo1.paused).to.eq(true)

      const orderInfo2 = await poolContract.connect(testAddrs.owner).getOrder(orderId2)
      expect(orderInfo2.paused).to.eq(true)

      // Now cancel orders 1 and 2 as the owner and delegate, respectively.
      // Expect the balances of T0 and T1 of the owner to increase each time.
      //

      // Order 1 (Owner cancel):
      let prevBalT0 = await token0AssetContract.balanceOf(testAddrs.owner.address)
      let prevBalT1 = await token1AssetContract.balanceOf(testAddrs.owner.address)

      await swap1.cancelLongTerm(orderId1, testAddrs.owner)
      let newBalT0 = await token0AssetContract.balanceOf(testAddrs.owner.address)
      let newBalT1 = await token1AssetContract.balanceOf(testAddrs.owner.address)
      expect(newBalT0, 'Owner should receive refund').to.be.gt(prevBalT0)
      expect(newBalT1, 'Owner should receive proceeds').to.be.gt(prevBalT1)
      
      // Order 2 (Delegate cancel):
      prevBalT0 = await token0AssetContract.balanceOf(testAddrs.owner.address)
      prevBalT1 = await token1AssetContract.balanceOf(testAddrs.owner.address)

      await swap2.cancelLongTerm(orderId2, testAddrs.delegate, testAddrs.owner)
      newBalT0 = await token0AssetContract.balanceOf(testAddrs.owner.address)
      newBalT1 = await token1AssetContract.balanceOf(testAddrs.owner.address)
      expect(newBalT0, 'Owner should receive refund when delegate cancels').to.be.gt(prevBalT0)
      expect(newBalT1, 'Owner should receive proceeds when delegate cancels').to.be.gt(prevBalT1)
    })
    
    it ("Can withdraw a paused, expired, order", async function() {
      // Create three orders:
      //
      const swapAmt3k = scaleUp(3_000n, TOKEN0_DECIMALS)

      const swap1 = swapMgr.newSwap0To1()
      const swapObjects1 = await swap1.longTerm(
        swapAmt3k, 
        0,          // intervals (1 will be added by contract)
        testAddrs.owner,
        true,   /* doSwap */
        true,   /* doApprovals */
        testAddrs.delegate
      )

      const swap2 = swapMgr.newSwap1To0()
      const swapObjects2 = await swap2.longTerm(
        swapAmt3k, 
        0,          // intervals
        testAddrs.owner,
        true,   /* doSwap */
        true,   /* doApprovals */
        testAddrs.delegate
      )
      
      const swap3 = swapMgr.newSwap0To1()
      const swapObjects3 = await swap3.longTerm(
        swapAmt3k, 
        0,          // intervals (1 will be added by contract)
        testAddrs.owner,
        true,   /* doSwap */
        true,   /* doApprovals */
        testAddrs.delegate
      )

      // Mine a few blocks, then pause all orders and confirm paused status:
      //
      await mineBlocks(10)

      const orderId1 = swap1.getOrderId()
      await poolContract.connect(testAddrs.owner).pauseOrder(orderId1)

      const orderId2 = swap2.getOrderId()
      await poolContract.connect(testAddrs.owner).pauseOrder(orderId2)
      
      const orderId3 = swap3.getOrderId()
      await poolContract.connect(testAddrs.owner).pauseOrder(orderId3)

      await mineBlocks()

      let orderInfo1 = await poolContract.connect(testAddrs.owner).getOrder(orderId1)
      expect(orderInfo1.paused).to.eq(true)

      let orderInfo2 = await poolContract.connect(testAddrs.owner).getOrder(orderId2)
      expect(orderInfo2.paused).to.eq(true)
      
      let orderInfo3 = await poolContract.connect(testAddrs.owner).getOrder(orderId3)
      expect(orderInfo3.paused).to.eq(true)

      // Mine all orders to expiry and confirm expired and paused status:
      //
      const lastExpiry = Math.max(orderInfo1.orderExpiry,
                                  orderInfo2.orderExpiry,
                                  orderInfo3.orderExpiry)
      let blockNumber = await getLastBlockNumber()
      const blocksToMine = lastExpiry - blockNumber + 1

      await mineBlocks(blocksToMine)

      blockNumber = await getLastBlockNumber()

      orderInfo1 = await poolContract.connect(testAddrs.owner).getOrder(orderId1)
      expect(orderInfo1.orderExpiry).to.be.lt(blockNumber)
      expect(orderInfo1.paused).to.eq(true)

      orderInfo2 = await poolContract.connect(testAddrs.owner).getOrder(orderId2)
      expect(orderInfo2.orderExpiry).to.be.lt(blockNumber)
      expect(orderInfo2.paused).to.eq(true)
      
      orderInfo3 = await poolContract.connect(testAddrs.owner).getOrder(orderId3)
      expect(orderInfo3.orderExpiry).to.be.lt(blockNumber)
      expect(orderInfo3.paused).to.eq(true)

      // Now withdraw orders 1, 2 as the owner and delegate, respectively.
      // Withdraw order 3 as the owner, but send funds to the delegate.
      // Confirm recipient receives both proceeds and refund.
      //

      // Order 1 (Owner withdraw)
      let prevBalT0 = await token0AssetContract.balanceOf(testAddrs.owner.address)
      let prevBalT1 = await token1AssetContract.balanceOf(testAddrs.owner.address)

      await swap1.withdrawLongTerm(orderId1, testAddrs.owner)
      let newBalT0 = await token0AssetContract.balanceOf(testAddrs.owner.address)
      let newBalT1 = await token1AssetContract.balanceOf(testAddrs.owner.address)
      expect(newBalT0, 'Owner should receive refund').to.be.gt(prevBalT0)
      expect(newBalT1, 'Owner should receive proceeds').to.be.gt(prevBalT1)

      // Order 2 (Delegate withdraw)
      prevBalT0 = await token0AssetContract.balanceOf(testAddrs.owner.address)
      prevBalT1 = await token1AssetContract.balanceOf(testAddrs.owner.address)

      await swap2.withdrawLongTerm(orderId2, testAddrs.delegate, testAddrs.owner)
      newBalT0 = await token0AssetContract.balanceOf(testAddrs.owner.address)
      newBalT1 = await token1AssetContract.balanceOf(testAddrs.owner.address)
      expect(newBalT0, 'Owner should receive refund when delegate withdraws').to.be.gt(prevBalT0)
      expect(newBalT1, 'Owner should receive proceeds when delegate withdraws').to.be.gt(prevBalT1)
      
      // Order 3 (Owner withdraw to delegate)
      prevBalT0 = await token0AssetContract.balanceOf(testAddrs.delegate.address)
      prevBalT1 = await token1AssetContract.balanceOf(testAddrs.delegate.address)

      await swap3.withdrawLongTerm(
        orderId3,
        testAddrs.owner,    // sender
        testAddrs.delegate  // recipient
      )
      newBalT0 = await token0AssetContract.balanceOf(testAddrs.delegate.address)
      newBalT1 = await token1AssetContract.balanceOf(testAddrs.delegate.address)
      expect(newBalT0, 'Delegate should receive refund').to.be.gt(prevBalT0)
      expect(newBalT1, 'Delegate should receive proceeds').to.be.gt(prevBalT1)
    })
    
    it ("Can withdraw an unpaused, expired, order", async function() {
      // Create three orders:
      //
      const swapAmt4k = scaleUp(4_000n, TOKEN0_DECIMALS)

      const swap1 = swapMgr.newSwap0To1()
      const swapObjects1 = await swap1.longTerm(
        swapAmt4k, 
        0,          // intervals (1 will be added by contract)
        testAddrs.owner,
        true,   /* doSwap */
        true,   /* doApprovals */
        testAddrs.delegate
      )

      const swap2 = swapMgr.newSwap1To0()
      const swapObjects2 = await swap2.longTerm(
        swapAmt4k, 
        0,          // intervals
        testAddrs.owner,
        true,   /* doSwap */
        true,   /* doApprovals */
        testAddrs.delegate
      )
      
      const swap3 = swapMgr.newSwap0To1()
      const swapObjects3 = await swap3.longTerm(
        swapAmt4k, 
        0,          // intervals (1 will be added by contract)
        testAddrs.owner,
        true,   /* doSwap */
        true,   /* doApprovals */
        testAddrs.delegate
      )

      // Mine a few blocks then pause all orders and confirm paused status:
      //
      await mineBlocks(10)

      const orderId1 = swap1.getOrderId()
      const orderId2 = swap2.getOrderId()
      const orderId3 = swap3.getOrderId()

      await poolContract.connect(testAddrs.owner).pauseOrder(orderId1)
      await poolContract.connect(testAddrs.owner).pauseOrder(orderId2)
      await poolContract.connect(testAddrs.owner).pauseOrder(orderId3)

      await mineBlocks()

      let orderInfo1 = await poolContract.connect(testAddrs.owner).getOrder(orderId1)
      expect(orderInfo1.paused).to.eq(true)

      let orderInfo2 = await poolContract.connect(testAddrs.owner).getOrder(orderId2)
      expect(orderInfo2.paused).to.eq(true)
      
      let orderInfo3 = await poolContract.connect(testAddrs.owner).getOrder(orderId3)
      expect(orderInfo3.paused).to.eq(true)

      // Mine a few more blocks, then unpause all orders and confirm unpaused status:
      //
      await mineBlocks(10)

      await poolContract.connect(testAddrs.owner).resumeOrder(orderId1)
      await poolContract.connect(testAddrs.owner).resumeOrder(orderId2)
      await poolContract.connect(testAddrs.owner).resumeOrder(orderId3)

      await mineBlocks()

      orderInfo1 = await poolContract.connect(testAddrs.owner).getOrder(orderId1)
      expect(orderInfo1.paused).to.eq(false)

      orderInfo2 = await poolContract.connect(testAddrs.owner).getOrder(orderId2)
      expect(orderInfo2.paused).to.eq(false)
      
      orderInfo3 = await poolContract.connect(testAddrs.owner).getOrder(orderId3)
      expect(orderInfo3.paused).to.eq(false)

      // Mine all orders to expiry and confirm expired, unpaused status:
      //
      const lastExpiry = Math.max(orderInfo1.orderExpiry,
                                  orderInfo2.orderExpiry,
                                  orderInfo3.orderExpiry)
      let blockNumber = await getLastBlockNumber()
      const blocksToMine = lastExpiry - blockNumber + 1

      await mineBlocks(blocksToMine)
      
      blockNumber = await getLastBlockNumber()

      orderInfo1 = await poolContract.connect(testAddrs.owner).getOrder(orderId1)
      expect(orderInfo1.orderExpiry).to.be.lt(blockNumber)
      expect(orderInfo1.paused).to.eq(false)

      orderInfo2 = await poolContract.connect(testAddrs.owner).getOrder(orderId2)
      expect(orderInfo2.orderExpiry).to.be.lt(blockNumber)
      expect(orderInfo2.paused).to.eq(false)
      
      orderInfo3 = await poolContract.connect(testAddrs.owner).getOrder(orderId3)
      expect(orderInfo3.orderExpiry).to.be.lt(blockNumber)
      expect(orderInfo3.paused).to.eq(false)
      
      // Now withdraw orders 1, 2 as the owner and delegate, respectively.
      // Withdraw order 3 as the owner, but send funds to the delegate.
      // Confirm paused status. Confirm recipient receives both proceeds and refund.
      //

      // Order 1 (Owner withdraw)
      let prevBalT0 = await token0AssetContract.balanceOf(testAddrs.owner.address)
      let prevBalT1 = await token1AssetContract.balanceOf(testAddrs.owner.address)

      await swap1.withdrawLongTerm(orderId1, testAddrs.owner)
      let newBalT0 = await token0AssetContract.balanceOf(testAddrs.owner.address)
      let newBalT1 = await token1AssetContract.balanceOf(testAddrs.owner.address)
      expect(newBalT0, 'Owner should receive refund').to.be.gt(prevBalT0)
      expect(newBalT1, 'Owner should receive proceeds').to.be.gt(prevBalT1)

      // Order 2 (Delegate withdraw)
      prevBalT0 = await token0AssetContract.balanceOf(testAddrs.owner.address)
      prevBalT1 = await token1AssetContract.balanceOf(testAddrs.owner.address)

      await swap2.withdrawLongTerm(orderId2, testAddrs.delegate, testAddrs.owner)
      newBalT0 = await token0AssetContract.balanceOf(testAddrs.owner.address)
      newBalT1 = await token1AssetContract.balanceOf(testAddrs.owner.address)
      expect(newBalT0, 'Owner should receive refund when delegate withdraws').to.be.gt(prevBalT0)
      expect(newBalT1, 'Owner should receive proceeds when delegate withdraws').to.be.gt(prevBalT1)
      
      // Order 3 (Owner withdraw to delegate)
      prevBalT0 = await token0AssetContract.balanceOf(testAddrs.delegate.address)
      prevBalT1 = await token1AssetContract.balanceOf(testAddrs.delegate.address)

      await swap3.withdrawLongTerm(
        orderId3,
        testAddrs.owner,    // sender
        testAddrs.delegate  // recipient
      )
      newBalT0 = await token0AssetContract.balanceOf(testAddrs.delegate.address)
      newBalT1 = await token1AssetContract.balanceOf(testAddrs.delegate.address)
      expect(newBalT0, 'Delegate should receive refund').to.be.gt(prevBalT0)
      expect(newBalT1, 'Delegate should receive proceeds').to.be.gt(prevBalT1)
    })
  })
})

