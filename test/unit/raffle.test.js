const { assert, expect } = require("chai")
const { network, getNamedAccounts, deployments, ethers } = require("hardhat")
const { isCallTrace } = require("hardhat/internal/hardhat-network/stack-traces/message-trace")
const { developmentChains, networkConfig } = require("../../helper-hardhat-config")

!developmentChains.includes(network.name)
    ? describe.skip
    : describe("Raffle", async function () {
          let raffle, VRFCoordinatorV2Mock, deployer, interval
          const chainId = network.config.chainId

          beforeEach(async function () {
              deployer = (await getNamedAccounts()).deployer
              await deployments.fixture("all")
              raffle = await ethers.getContract("Raffle", deployer)
              VRFCoordinatorV2Mock = await ethers.getContract("VRFCoordinatorV2Mock", deployer)
              interval = await raffle.getInterval()
          })

          describe("constructor", function () {
              it("initializes the raffle correctly", async function () {
                  // Ideally 1 assert/it
                  const raffleState = await raffle.getRaffleState()
                  assert.equal(raffleState.toString(), "0")
                  assert.equal(interval.toString(), networkConfig[chainId]["interval"])
              })
          })

          describe("enterRaffle", function () {
              it("reverts when you don't pay enough", async function () {
                  sendValue = ethers.utils.parseEther("0")
                  await expect(raffle.enterRaffle({ value: sendValue })).to.be.revertedWith(
                      "Raffle__NotEnoughEthEntered"
                  )
              })
              it("adds players to the s_players array when entering", async function () {
                  sendValue = ethers.utils.parseEther("30")
                  await raffle.enterRaffle({ value: sendValue })
                  const entrant = await raffle.getPlayer(0)
                  assert.equal(entrant, deployer)
              })

              it("emits an event on enter", async function () {
                  sendValue = ethers.utils.parseEther("30")
                  await expect(raffle.enterRaffle({ value: sendValue })).to.emit(
                      raffle,
                      "RaffleEnter"
                  )
              })

              it("doesn't allow entrance when app is not open", async function () {
                  sendValue = ethers.utils.parseEther("30")
                  await raffle.enterRaffle({ value: sendValue })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  // pretending to be a Keeper
                  await raffle.performUpkeep([])
                  await expect(raffle.enterRaffle({ value: sendValue })).to.be.revertedWith(
                      "Raffle__NotOpen"
                  )
              })
          })
          describe("checkUpkeep", function () {
              it("returns false if people haven't sent ETH", async function () {
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  const { upKeepNeeded } = await raffle.callStatic.checkUpkeep([])
                  assert(!upKeepNeeded)
              })

              it("returns false if raffle isn't open", async function () {
                  sendValue = ethers.utils.parseEther("30")
                  await raffle.enterRaffle({ value: sendValue })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  await raffle.performUpkeep([])
                  const raffleState = await raffle.getRaffleState()
                  const { upKeepNeeded } = await raffle.callStatic.checkUpkeep([])
                  assert(!upKeepNeeded)
                  assert.equal(raffleState.toString(), "1")
              })

              it("returns false if enough time hasn't passed", async function () {
                  sendValue = ethers.utils.parseEther("30")
                  await raffle.enterRaffle({ value: sendValue })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() - 1])
                  await network.provider.send("evm_mine", [])
                  const { upKeepNeeded } = await raffle.callStatic.checkUpkeep([])
                  assert(!upKeepNeeded)
              })

              it("returns true if enough time has passed, has players, eth, and is open", async () => {
                  sendValue = ethers.utils.parseEther("30")
                  await raffle.enterRaffle({ value: sendValue })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.request({ method: "evm_mine", params: [] })
                  const { upkeepNeeded } = await raffle.callStatic.checkUpkeep("0x")
                  assert(upkeepNeeded)
              })
          })

          describe("performUpkeep", function () {
              it("reverts if upkeep not needed", async function () {
                  sendValue = ethers.utils.parseEther("30")
                  await raffle.enterRaffle({ value: sendValue })
                  //   await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  //   await network.provider.send("evm_mine", [])
                  await expect(raffle.performUpkeep([])).to.be.revertedWith(
                      "Raffle__UpkeepNotNeeded"
                  )
              })

              it("sets the raffleState to 'CALCULATING'", async function () {
                  sendValue = ethers.utils.parseEther("30")
                  await raffle.enterRaffle({ value: sendValue })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  await raffle.performUpkeep([])
                  const raffleState = await raffle.getRaffleState()
                  assert.equal(raffleState, "1")
              })

              it("emits a requested raffle winner", async function () {
                  sendValue = ethers.utils.parseEther("30")
                  await raffle.enterRaffle({ value: sendValue })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  await expect(raffle.performUpkeep([])).to.emit(raffle, "RequestedRaffleWinner")
              })
          })

          describe("fulfillRandomWords", function () {
              beforeEach(async function () {
                  sendValue = ethers.utils.parseEther("30")
                  await raffle.enterRaffle({ value: sendValue })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
              })
              it("can only be called after performUpkeep", async function () {
                  await expect(
                      VRFCoordinatorV2Mock.fulfillRandomWords(0, raffle.address)
                  ).to.be.revertedWith("nonexistent request")
                  await expect(
                      VRFCoordinatorV2Mock.fulfillRandomWords(1, raffle.address)
                  ).to.be.revertedWith("nonexistent request")
              })
              // waaaaayyyyy too big
              it("picks a winner, resets the lottery, and sends money", async function () {
                  const additionalEntrants = 3
                  const startingAccountIndex = 1 //deployer = 0
                  sendValue = ethers.utils.parseEther("30")
                  const accounts = await ethers.getSigners()
                  for (
                      let i = startingAccountIndex;
                      i < startingAccountIndex + additionalEntrants;
                      i++
                  ) {
                      const accountConnectedRaffle = raffle.connect(accounts[i])
                      await accountConnectedRaffle.enterRaffle({ value: sendValue })
                  }
                  const startingTimeStamp = await raffle.getLatestTimeStamp()
                  //performUpkeep (mock being chainlink keepers)
                  //fulfillRandomWords (mock being VRF)
                  //we have to wait for the fulfillRandomWords to be called
                  await new Promise(async (resolve, reject) => {
                      raffle.once("WinnerPicked", async () => {
                          console.log("Winner Picked event fired.")
                          try {
                              const recentWinner = await raffle.getRecentWinner()
                              const raffleState = await raffle.getRaffleState()
                              const numberOfPlayers = await raffle.getNumberOfPlayers()
                              const endingTimeStamp = await raffle.getLatestTimeStamp()
                              const winnerEndingBalance = await accounts[1].getBalance()

                              console.log("----")
                              console.log(`This is the winner! ${recentWinner}`)
                              console.log("----")
                              console.log(accounts[0].address)
                              console.log(accounts[1].address)
                              console.log(accounts[2].address)
                              console.log(accounts[3].address)

                              assert(endingTimeStamp > startingTimeStamp)
                              assert.equal(raffleState.toString(), "0")
                              assert(numberOfPlayers.toString(), "0")
                              assert.equal(
                                  winnerEndingBalance.toString(),
                                  winnerStartingBalance.add(
                                      sendValue.mul(additionalEntrants).add(sendValue).toString()
                                  )
                              )
                          } catch (e) {
                              reject(e)
                          }
                          resolve()
                      })

                      const tx = await raffle.performUpkeep([])
                      const txReceipt = await tx.wait(1)
                      const winnerStartingBalance = await accounts[1].getBalance()
                      await VRFCoordinatorV2Mock.fulfillRandomWords(
                          txReceipt.events[1].args.requestId,
                          raffle.address
                      )
                  })
              })
          })
      })

//   it("returns true if enough time has pass, has players, eth and is open", async function () {
//     sendValue = ethers.utils.parseEther("30")
//     await raffle.enterRaffle({ value: sendValue })
//     await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
//     await network.provider.request({ method: "evm_mine", params: [] })
//     const { upKeepNeeded } = await raffle.callStatic.checkUpkeep([])
//     assert(upKeepNeeded)
