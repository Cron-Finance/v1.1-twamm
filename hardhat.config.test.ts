import "@nomiclabs/hardhat-waffle";
import "@nomiclabs/hardhat-ethers";
import "@typechain/ethers-v5";
import "@typechain/hardhat";
import "hardhat-gas-reporter";
import "tsconfig-paths/register";
import "hardhat-tracer";

import { HardhatUserConfig } from "hardhat/config";

import config from "./hardhat.config";

// See this for usage:
//    - https://github.com/zemse/hardhat-tracer
//
require("hardhat-tracer");


const testConfig: HardhatUserConfig = {
  ...config,
  networks: {
    ...config.networks,
    hardhat: {
      ...config?.networks?.hardhat,
      allowUnlimitedContractSize: true,
    },
  },
};

export default testConfig;
