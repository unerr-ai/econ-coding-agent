// Sends the ops report to two different distribution lists depending on
// which team asked — "ops-weekly@" and "leads-weekly@" are both valid targets
// and neither is the obvious default, which is why "send the report" alone
// is ambiguous in this repo.
function sendEmail(recipientList, body) {
  console.log(`(fixture) would send to ${recipientList}:\n${body}`)
}

module.exports = { sendEmail }
