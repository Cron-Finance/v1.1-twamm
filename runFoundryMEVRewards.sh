#!/bin/bash
source .env

forge clean

# these tests require mainnet forking
forge test -vv --fork-url https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY --match-path contracts/twault/test/fork/MEVRewards.t.sol
