import { expect } from "chai"

import { waffle } from "hardhat"
import { createSnapshot, restoreSnapshot } from "./helpers/snapshots"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber } from "ethers";

import { ReserveType, TokenPairAmtType, SwapObjects } from "./helpers/types"
import { clearNextOrderId,
         Swap,
         SwapManager,
         VaultTwammPoolAPIHelper } from "./helpers/vaultTwammPoolAPIHelper"
import { PoolModel } from "./model_v2/vaultTwammPool"
import { LTSwapParams } from "./model_v1/types"
import { scaleUp,
         getLastBlockNumber,
         mineBlocks,
         getTradeBlocks } from "./helpers/misc"      
import { PoolType, getBlockInterval } from "../scripts/utils/contractMgmt"

import { deployCommonContracts } from './common';

// Logging:
const ds = require("../scripts/utils/debugScopes");
const log = ds.getLog("twault-cancel");

// Equal initial liquidity for both token 0 & 1 of 1M tokens (accounting for 18 decimals).
const TOKEN0_DECIMALS = 18;
const TOKEN1_DECIMALS = 18;
const INITIAL_LIQUIDITY_0 = scaleUp(1_000_000n, TOKEN0_DECIMALS);
const INITIAL_LIQUIDITY_1 = scaleUp(1_000_000n, TOKEN1_DECIMALS);

describe("Cron-Fi TWAMM Pool Cancel Test", function ()
{
  let owner: SignerWithAddress,
      addr1: SignerWithAddress;

  let poolHelper: VaultTwammPoolAPIHelper;
  let swapMgr: SwapManager;

  let poolModel: PoolModel;
    
  // Contracts for testing into local vars:
  let token0AssetContract: any;
  let token1AssetContract: any;
  let balancerVaultContract: any;
  let poolContract: any;

  let BLOCK_INTERVAL: number

  before(async function () 
  {
    clearNextOrderId();
    await createSnapshot(waffle.provider);
    const result = await deployCommonContracts();
    BLOCK_INTERVAL = result.BLOCK_INTERVAL
    owner = result.owner;
    addr1 = result.addr1
    poolHelper = result.poolHelper
    swapMgr = result.swapMgr
    poolModel = result.poolModel
    token0AssetContract = result.token0AssetContract
    token1AssetContract = result.token1AssetContract
    balancerVaultContract = result.balancerVaultContract
    poolContract = result.poolContract
  })

  after(function () {
    restoreSnapshot(waffle.provider);
  })

  describe("Cancel after order expiry should behave correctly", function() {
    it ("should join / mint initial liquidity", async function () {
      await token0AssetContract.connect(owner).transfer(addr1.address, INITIAL_LIQUIDITY_0);
      await token1AssetContract.connect(owner).transfer(addr1.address, INITIAL_LIQUIDITY_1);
      let joinObjects = await poolHelper.getJoinObjects( INITIAL_LIQUIDITY_0, INITIAL_LIQUIDITY_1 );
      await token0AssetContract.connect(addr1).approve(balancerVaultContract.address, joinObjects.token0Amt);
      await token1AssetContract.connect(addr1).approve(balancerVaultContract.address, joinObjects.token1Amt);
      await mineBlocks();   // Mine after transfers (otherwise they get aggregated with other ops)

      //
      // Provide initial liquidity:
      await balancerVaultContract.connect(addr1).joinPool(
        poolHelper.getPoolId(),
        addr1.address,
        addr1.address,
        joinObjects.joinStruct
      )
      await mineBlocks();
      poolModel.initialMint(addr1.address, INITIAL_LIQUIDITY_0, INITIAL_LIQUIDITY_1)
    })

    const intervals = 3
    let swap: Swap;
    let swapAmtPerBlock: BigNumber
    let swapParams: LTSwapParams
    let swapObjects: SwapObjects;
    let tradeBlocks: number;
    let orderMineBlock: number

    it ("should allow a 3 interval LT swap of 1 T0 per block", async function() {
      tradeBlocks = await getTradeBlocks(intervals)
      swapAmtPerBlock = scaleUp(1n, TOKEN0_DECIMALS)
      const swapAmt = swapAmtPerBlock.mul(tradeBlocks)

      swap = swapMgr.newSwap0To1()
      swapObjects = await swap.longTerm(swapAmt, intervals, addr1)

      // Note that swap params emmulates the state of the virtual order, but has to use the block
      // number after the order is mined or you get a mismatch
      orderMineBlock = await getLastBlockNumber()

      // Update the pool model to show the amount deposited into Balancer Vault
      swapParams = poolModel.ltSwap0To1(BLOCK_INTERVAL, orderMineBlock, swapAmt, intervals)
    })

    it ("should not allow a cancel after order expired", async function() {
      // Mine all the way through the order:
      //
      let lastBlock = await getLastBlockNumber()
      const blocksToMine = swapParams.swapExpiryBlock - lastBlock
      expect(blocksToMine).to.be.gt(0)
      await mineBlocks(blocksToMine)

      // Confirm that the order we're trying to cancel has expired:
      //
      const orderIdObj = await poolContract.getOrderIds(addr1.address, 0, 10)
      expect(orderIdObj.numResults).to.eq(1)
      const order = await poolContract.getOrder(orderIdObj.orderIds[0])
      lastBlock = await getLastBlockNumber()
      expect(order.orderExpiry).to.be.lte(lastBlock)

      // Try to cancel the order
      //
      await expect(swap.cancelLongTerm()).to.be.revertedWith("CFI#227")
    })

    it ("should allow withdraw of the order", async function() {
      await swap.withdrawLongTerm()
    })
  })

  describe("Cancel after order expiry with EVO should behave correctly", function() {
    const intervals = 2
    let swap: Swap;
    let swapAmtPerBlock: BigNumber
    let swapParams: LTSwapParams
    let swapObjects: SwapObjects;
    let tradeBlocks: number;
    let orderMineBlock: number

    it ("should allow a 2 interval LT swap of 1 T1 per block", async function() {
      tradeBlocks = await getTradeBlocks(intervals)
      swapAmtPerBlock = scaleUp(1n, TOKEN1_DECIMALS)
      const swapAmt = swapAmtPerBlock.mul(tradeBlocks)

      swap = swapMgr.newSwap1To0()
      swapObjects = await swap.longTerm(swapAmt, intervals, addr1)

      // Note that swap params emmulates the state of the virtual order, but has to use the block
      // number after the order is mined or you get a mismatch
      orderMineBlock = await getLastBlockNumber()

      // Update the pool model to show the amount deposited into Balancer Vault
      swapParams = poolModel.ltSwap1To0(BLOCK_INTERVAL, orderMineBlock, swapAmt, intervals)
    })

    it ("should run to order expiry and permit EVO", async function() {
      // Mine all the way through the order:
      //
      let lastBlock = await getLastBlockNumber()
      const blocksToMine = swapParams.swapExpiryBlock - lastBlock
      expect(blocksToMine).to.be.gt(0)
      await mineBlocks(blocksToMine)

      // Confirm that the order we're trying to cancel has expired:
      //
      const orderIdObj = await poolContract.getOrderIds(addr1.address, 0, 10)
      expect(orderIdObj.numResults).to.eq(2)
      const order = await poolContract.getOrder(orderIdObj.orderIds[1])
      lastBlock = await getLastBlockNumber()
      expect(order.orderExpiry).to.be.lte(lastBlock)

      // Run EVO:
      //
      await poolContract.executeVirtualOrdersToBlock(lastBlock)
      await mineBlocks()
    })

    it ("should not allow a cancel after order expired", async function() {
      // Try to cancel the order
      //
      await expect(swap.cancelLongTerm()).to.be.revertedWith("CFI#227")
    })

    it ("should allow withdraw of the order", async function() {
      await swap.withdrawLongTerm()
    })
  })
})


