/** A bank as identified by its code and display name. */
export interface Bank {
  /** Bank code. For NUBAN validation this must be the 3-digit CBN code. */
  readonly code: string;
  readonly name: string;
}

/**
 * Offline fallback: the banks that use 3-digit codes, as listed by Paystack
 * in October 2026 (57 entries, names verbatim from Paystack).
 *
 * Bank lists change (mergers, licence revocations, new banks), so treat this
 * as a snapshot. For current data use `client.getPossibleBanks()` or pass your
 * own list to `getPossibleBanks(accountNumber, banks)`.
 *
 * Banks with longer NIP codes (most fintechs and microfinance banks) are not
 * included: the 3-digit NUBAN check does not apply to them.
 */
export const DEFAULT_BANKS: readonly Bank[] = [
  { code: '011', name: 'First Bank of Nigeria' },
  { code: '023', name: 'Citibank Nigeria' },
  { code: '031', name: 'Living Trust Mortgage Bank' },
  { code: '032', name: 'Union Bank of Nigeria' },
  { code: '033', name: 'United Bank For Africa' },
  { code: '035', name: 'Wema Bank' },
  { code: '044', name: 'Access Bank' },
  { code: '050', name: 'Ecobank Nigeria' },
  { code: '057', name: 'Zenith Bank' },
  { code: '058', name: 'Guaranty Trust Bank' },
  { code: '063', name: 'Access Bank (Diamond)' },
  { code: '068', name: 'Standard Chartered Bank' },
  { code: '070', name: 'Fidelity Bank' },
  { code: '076', name: 'Polaris Bank' },
  { code: '082', name: 'Keystone Bank' },
  { code: '098', name: 'Ekondo Microfinance Bank' },
  { code: '100', name: 'Suntrust Bank' },
  { code: '101', name: 'Providus Bank' },
  { code: '102', name: 'Titan Bank' },
  { code: '104', name: 'Parallex Bank' },
  { code: '105', name: 'PremiumTrust Bank' },
  { code: '106', name: 'Signature Bank Ltd' },
  { code: '107', name: 'Optimus Bank Limited' },
  { code: '108', name: 'Alpha Morgan Bank' },
  { code: '109', name: 'Tatum Bank' },
  { code: '125', name: 'Rubies MFB' },
  { code: '214', name: 'First City Monument Bank' },
  { code: '215', name: 'Unity Bank' },
  { code: '221', name: 'Stanbic IBTC Bank' },
  { code: '232', name: 'Sterling Bank' },
  { code: '268', name: 'Platinum Mortgage Bank' },
  { code: '301', name: 'Jaiz Bank' },
  { code: '302', name: 'TAJ Bank' },
  { code: '303', name: 'Lotus Bank' },
  { code: '311', name: 'Parkway - ReadyCash' },
  { code: '312', name: 'Chikum Microfinance bank' },
  { code: '401', name: 'ASO Savings and Loans' },
  { code: '402', name: 'Jubilee Life Mortgage Bank' },
  { code: '404', name: 'Abbey Mortgage Bank' },
  { code: '413', name: 'FirstTrust Mortgage Bank Nigeria' },
  { code: '415', name: 'IMPERIAL HOMES MORTAGE BANK' },
  { code: '501', name: 'FSDH Merchant Bank Limited' },
  { code: '502', name: 'Rand Merchant Bank' },
  { code: '559', name: 'Coronation Merchant Bank' },
  { code: '561', name: 'NOVA BANK' },
  { code: '562', name: 'Greenwich Merchant Bank' },
  { code: '565', name: 'Carbon' },
  { code: '566', name: 'VFD Microfinance Bank Limited' },
  { code: '594', name: 'Yes MFB' },
  { code: '602', name: 'Accion Microfinance Bank' },
  { code: '650', name: 'Bosak Microfinance Bank' },
  { code: '677', name: 'Think Finance Microfinance Bank' },
  { code: '812', name: 'Gateway Mortgage Bank LTD' },
  { code: '832', name: 'FUTMINNA MICROFINANCE BANK' },
  { code: '865', name: 'CASHCONNECT MFB' },
  { code: '899', name: 'Kolomoni MFB' },
  { code: '946', name: 'Money Master PSB' },
];