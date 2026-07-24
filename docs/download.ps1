param(
    [Parameter(Mandatory = $true)]
    [string]$Enterprise,
 
    [Parameter(Mandatory = $true)]
    [string]$Org,
 
    [string]$Day = $null,
 
    [string]$OutDir = "data/raw",
 
    [switch]$BudgetOnly
)
 
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
 
function Normalize-Slug {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value,
        [Parameter(Mandatory = $true)]
        [string]$Segment
    )
 
    if ($Value -match "^https?://") {
        $m = [regex]::Match($Value, "/$Segment/([^/?#]+)", [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        if ($m.Success) {
            return $m.Groups[1].Value
        }
 
        # For org URLs like https://github.com/ORG
        if ($Segment -eq "github.com") {
            $u = [Uri]$Value
            $parts = $u.AbsolutePath.Trim('/').Split('/')
            if ($parts.Length -ge 1 -and -not [string]::IsNullOrWhiteSpace($parts[0])) {
                return $parts[0]
            }
        }
    }
 
    return $Value.Trim().Trim('/')
}
 
function Invoke-GitHubJson {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Url
    )
 
    return Invoke-RestMethod -Method Get -Uri $Url -Headers $script:Headers
}
 
function Download-MaybeGzipToNdjson {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Url,
        [Parameter(Mandatory = $true)]
        [string]$OutputNdjsonPath
    )
 
    $tmpFile = "$OutputNdjsonPath.tmp"
    Invoke-WebRequest -Method Get -Uri $Url -OutFile $tmpFile
 
    $bytes = [System.IO.File]::ReadAllBytes($tmpFile)
    if ($bytes.Length -ge 2 -and $bytes[0] -eq 31 -and $bytes[1] -eq 139) {
        $inStream = [System.IO.File]::OpenRead($tmpFile)
        try {
            $gzip = New-Object System.IO.Compression.GZipStream($inStream, [System.IO.Compression.CompressionMode]::Decompress)
            $outStream = [System.IO.File]::Create($OutputNdjsonPath)
            try {
                $gzip.CopyTo($outStream)
            }
            finally {
                $outStream.Dispose()
                $gzip.Dispose()
            }
        }
        finally {
            $inStream.Dispose()
        }
        Remove-Item $tmpFile -Force
    }
    else {
        Move-Item -Path $tmpFile -Destination $OutputNdjsonPath -Force
    }
}
 
function Get-AllBudgets {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BaseUrl
    )
 
    $rows = @()
    $page = 1
    $perPage = 100
 
    while ($true) {
        $separator = if ($BaseUrl.Contains("?")) { "&" } else { "?" }
        $url = "$BaseUrl${separator}per_page=$perPage&page=$page"
        $resp = Invoke-GitHubJson -Url $url
 
        $pageBudgets = @()
        if ($resp.PSObject.Properties.Name -contains 'budgets' -and $resp.budgets) {
            $pageBudgets = @($resp.budgets)
            $rows += $pageBudgets
        }
 
        $hasNextPage = $false
        if ($resp.PSObject.Properties.Name -contains 'has_next_page') {
            $hasNextPage = [bool]$resp.has_next_page
        }
        elseif ($pageBudgets.Count -eq $perPage) {
            $hasNextPage = $true
        }
 
        if (-not $hasNextPage) {
            break
        }
 
        $page++
    }
 
    return $rows
}
 
$token = $env:GITHUB_TOKEN
if ([string]::IsNullOrWhiteSpace($token)) {
    throw "Missing GITHUB_TOKEN environment variable. In terminal run: `$env:GITHUB_TOKEN = 'YOUR_TOKEN'"
}
 
$enterpriseSlug = Normalize-Slug -Value $Enterprise -Segment "enterprises"
$orgSlug = Normalize-Slug -Value $Org -Segment "github.com"
 
if ([string]::IsNullOrWhiteSpace($Day)) {
    $today = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
}
else {
    $today = [datetime]::ParseExact($Day, "yyyy-MM-dd", $null).ToString("yyyy-MM-dd")
}
$dt = [datetime]::ParseExact($today, "yyyy-MM-dd", $null)
$year = $dt.Year
$month = $dt.Month
$day = $dt.Day
 
$root = (Resolve-Path ".").Path
$outPath = Join-Path $root $OutDir
New-Item -ItemType Directory -Path $outPath -Force | Out-Null
 
$script:Headers = @{
    Authorization = "Bearer $token"
    Accept = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2026-03-10"
}
 
Write-Host "Downloading data for UTC day $today"
Write-Host "Enterprise: $enterpriseSlug"
Write-Host "Organization: $orgSlug"
 
if ($BudgetOnly) {
    Write-Host "Mode: budget-only (skipping usage/seats/per-user billing/cost-center summary)"
}
 
# 1) Usage users 1-day report (organization scope, fail-fast)
if (-not $BudgetOnly) {
    $usageMetaUrl = "https://api.github.com/orgs/$orgSlug/copilot/metrics/reports/users-1-day?day=$today"
    $usageMeta = Invoke-GitHubJson -Url $usageMetaUrl
    $usageMeta | Add-Member -NotePropertyName "resolved_scope" -NotePropertyValue "organization" -Force
    $usageMeta | Add-Member -NotePropertyName "resolved_url" -NotePropertyValue $usageMetaUrl -Force
    $usageMetaPath = Join-Path $outPath "usage_users_${today}_meta.json"
    $usageMeta | ConvertTo-Json -Depth 20 | Out-File -FilePath $usageMetaPath -Encoding utf8
 
    $combinedUsagePath = Join-Path $outPath "usage_users_${today}.ndjson"
    if (Test-Path $combinedUsagePath) {
        Remove-Item $combinedUsagePath -Force
    }
 
    if (-not ($usageMeta.PSObject.Properties.Name -contains 'download_links') -or -not $usageMeta.download_links -or $usageMeta.download_links.Count -eq 0) {
        throw "Usage report for $today does not contain download_links."
    }
 
    $index = 1
    foreach ($link in $usageMeta.download_links) {
        $partPath = Join-Path $outPath ("usage_users_{0}_part{1:00}.ndjson" -f $today, $index)
        Download-MaybeGzipToNdjson -Url $link -OutputNdjsonPath $partPath
        Get-Content -Path $partPath -Encoding UTF8 | Add-Content -Path $combinedUsagePath -Encoding UTF8
        $index++
    }
}
 
if (-not $BudgetOnly) {
    # 2) Seats (organization)
    $allSeats = @()
    $page = 1
    $perPage = 100
    while ($true) {
        $seatsUrl = "https://api.github.com/orgs/$orgSlug/copilot/billing/seats?per_page=$perPage&page=$page"
        $seatsResp = Invoke-GitHubJson -Url $seatsUrl
        if ($seatsResp.PSObject.Properties.Name -contains 'seats' -and $seatsResp.seats) {
            $allSeats += $seatsResp.seats
        }
 
        $count = 0
        if ($seatsResp.PSObject.Properties.Name -contains 'seats' -and $seatsResp.seats) {
            $count = $seatsResp.seats.Count
        }
 
        if ($count -lt $perPage) {
            break
        }
 
        $page++
    }
 
    $seatsPath = Join-Path $outPath "seats_${today}.json"
    $allSeats | ConvertTo-Json -Depth 20 | Out-File -FilePath $seatsPath -Encoding utf8
 
    $seatsFlatPath = Join-Path $outPath "seats_${today}.csv"
    $allSeats |
        Select-Object @{n='user_login';e={$_.assignee.login}}, @{n='user_id';e={$_.assignee.id}}, created_at, last_activity_at, last_authenticated_at, plan_type, pending_cancellation_date |
        Export-Csv -Path $seatsFlatPath -NoTypeInformation -Encoding utf8
}
 
# 3) Billing (per-user enterprise-level AI credits usage)
$billingPath = $null
$billingFlatPath = $null
$costCenterBillingPath = $null
$costCenterBillingFlatPath = $null
$budgetsCurrentPath = $null
$budgetsCurrentFlatPath = $null
 
if (-not $BudgetOnly) {
    # Extract unique users from usage data
    $usersFromUsage = @()
    Get-Content -Path (Join-Path $outPath "usage_users_${today}.ndjson") -Encoding UTF8 | ForEach-Object {
        if (-not [string]::IsNullOrWhiteSpace($_)) {
            $json = $_ | ConvertFrom-Json
            $usersFromUsage += $json.user_login
        }
    }
    $uniqueUsers = $usersFromUsage | Select-Object -Unique
    Write-Host "Found $($uniqueUsers.Count) unique users from usage metrics"
 
    if ($uniqueUsers.Count -gt 0) {
        $allBillingItems = @()
        $userCount = 0
       
        foreach ($username in $uniqueUsers) {
            $userCount++
            $billingUrl = "https://api.github.com/enterprises/$enterpriseSlug/settings/billing/ai_credit/usage?year=$year&month=$month&day=$day&user=$username"
           
            try {
                $billingResp = Invoke-GitHubJson -Url $billingUrl
                if ($billingResp.PSObject.Properties.Name -contains 'usageItems' -and $billingResp.usageItems) {
                    foreach ($item in $billingResp.usageItems) {
                        $allBillingItems += [PSCustomObject]@{
                            date = $today
                            username = $username
                            product = $item.product
                            sku = $item.sku
                            model = $item.model
                            quantity = $item.grossQuantity
                            unit_type = $item.unitType
                            applied_cost_per_quantity = $item.pricePerUnit
                            gross_amount = $item.grossAmount
                            discount_amount = $item.discountAmount
                            net_amount = $item.netAmount
                        }
                    }
                }
               
                if ($userCount % 50 -eq 0) {
                    Write-Host "  Processed $userCount/$($uniqueUsers.Count) users..."
                }
            }
            catch {
                Write-Host "  Warning: Failed to get billing for user $username : $_" -ForegroundColor Yellow
            }
        }
       
        if ($allBillingItems.Count -gt 0) {
            $billingPath = Join-Path $outPath "billing_ai_credit_per_user_${today}.json"
            $allBillingItems | ConvertTo-Json -Depth 20 | Out-File -FilePath $billingPath -Encoding utf8
           
            $billingFlatPath = Join-Path $outPath "billing_ai_credit_per_user_${today}.csv"
            $allBillingItems |
                Select-Object date, username, product, sku, model, quantity, unit_type, applied_cost_per_quantity, gross_amount, discount_amount, net_amount |
                Export-Csv -Path $billingFlatPath -NoTypeInformation -Encoding utf8
           
            Write-Host "Billing data: $($allBillingItems.Count) items for $($uniqueUsers.Count) users"
        }
        else {
            Write-Host "No billing items found for any user"
        }
    }
    else {
        Write-Host "No users found in usage data, skipping billing"
    }
}
 
if (-not $BudgetOnly) {
    # 4) Cost-center billing summary (includes license/user-months billed amounts)
    try {
        $costCentersUrl = "https://api.github.com/enterprises/$enterpriseSlug/settings/billing/cost-centers?per_page=100"
        $costCentersResp = Invoke-GitHubJson -Url $costCentersUrl
 
    $costCenters = @()
    if ($costCentersResp.PSObject.Properties.Name -contains 'costCenters' -and $costCentersResp.costCenters) {
        $costCenters = @($costCentersResp.costCenters)
    }
    elseif ($costCentersResp.PSObject.Properties.Name -contains 'cost_centers' -and $costCentersResp.cost_centers) {
        $costCenters = @($costCentersResp.cost_centers)
    }
 
    $orgCostCenter = $costCenters |
        Where-Object {
            $_.state -eq 'active' -and
            $_.resources -and
            (($_.resources | Where-Object { $_.type -eq 'Org' -and $_.name -eq $orgSlug }) | Select-Object -First 1)
        } |
        Select-Object -First 1
 
    if ($orgCostCenter) {
        $costCenterId = $orgCostCenter.id
        $summaryUrl = "https://api.github.com/enterprises/$enterpriseSlug/settings/billing/usage/summary?year=$year&month=$month&day=$day&cost_center_id=$costCenterId"
        $summaryResp = Invoke-GitHubJson -Url $summaryUrl
 
        $costCenterBillingPath = Join-Path $outPath "billing_cost_center_summary_${today}.json"
        $summaryResp | ConvertTo-Json -Depth 20 | Out-File -FilePath $costCenterBillingPath -Encoding utf8
 
        $summaryRows = @()
        if ($summaryResp.PSObject.Properties.Name -contains 'usageItems' -and $summaryResp.usageItems) {
            foreach ($item in $summaryResp.usageItems) {
                $summaryRows += [PSCustomObject]@{
                    date = $today
                    enterprise = $enterpriseSlug
                    organization = $orgSlug
                    cost_center_id = $costCenterId
                    cost_center_name = $orgCostCenter.name
                    product = $item.product
                    sku = $item.sku
                    unit_type = $item.unitType
                    price_per_unit = $item.pricePerUnit
                    gross_quantity = $item.grossQuantity
                    discount_quantity = $item.discountQuantity
                    net_quantity = $item.netQuantity
                    gross_amount = $item.grossAmount
                    discount_amount = $item.discountAmount
                    net_amount = $item.netAmount
                }
            }
        }
 
        $costCenterBillingFlatPath = Join-Path $outPath "billing_cost_center_summary_${today}.csv"
        $summaryRows |
            Select-Object date, enterprise, organization, cost_center_id, cost_center_name, product, sku, unit_type, price_per_unit, gross_quantity, discount_quantity, net_quantity, gross_amount, discount_amount, net_amount |
            Export-Csv -Path $costCenterBillingFlatPath -NoTypeInformation -Encoding utf8
 
        Write-Host "Cost-center billing summary: $($summaryRows.Count) usage items"
    }
    else {
        Write-Host "Warning: No active cost center found for org $orgSlug. Skipping cost-center billing summary." -ForegroundColor Yellow
    }
    }
    catch {
        Write-Host "Warning: Failed to download cost-center billing summary ($_). Skipping." -ForegroundColor Yellow
    }
}
 
# 5) Budgets (current state only, no historical snapshot)
try {
    $allBudgets = @()
    $budgetSource = ""
 
    try {
        $allBudgets = @(Get-AllBudgets -BaseUrl "https://api.github.com/organizations/$orgSlug/settings/billing/budgets")
        $budgetSource = "organization"
    }
    catch {
        $status = $null
        if ($_.Exception.Response) {
            $status = [int]$_.Exception.Response.StatusCode
        }
 
        if ($status -eq 404) {
            # Some tenants expose budgets only on enterprise endpoint.
            # Collect the commonly used scopes and merge them by id.
            $scopeCandidates = @("organization", "multi_user_customer", "enterprise", "repository", "user", "cost_center")
            $allEnterpriseBudgets = @()
 
            foreach ($scopeCandidate in $scopeCandidates) {
                $scopeRows = @(Get-AllBudgets -BaseUrl "https://api.github.com/enterprises/$enterpriseSlug/settings/billing/budgets?scope=$scopeCandidate")
                if ($scopeRows.Count -gt 0) {
                    $allEnterpriseBudgets += $scopeRows
                }
            }
 
            $allBudgets = @($allEnterpriseBudgets | Group-Object -Property id | ForEach-Object { $_.Group | Select-Object -First 1 })
            $budgetSource = "enterprise_scopes"
        }
        else {
            throw
        }
    }
 
    $budgetsCurrentPath = Join-Path $outPath "budgets_current.json"
    $allBudgets | ConvertTo-Json -Depth 20 | Out-File -FilePath $budgetsCurrentPath -Encoding utf8
 
    $snapshotUtc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    $budgetsRows = @()
    foreach ($budget in $allBudgets) {
        $alertRecipients = ""
        if ($budget.PSObject.Properties.Name -contains 'budget_alerting' -and $budget.budget_alerting -and $budget.budget_alerting.alert_recipients) {
            $alertRecipients = ($budget.budget_alerting.alert_recipients -join ";")
        }
 
        $consumedAmount = $null
        if ($budget.PSObject.Properties.Name -contains 'consumed_amount') {
            $consumedAmount = $budget.consumed_amount
        }
 
        $budgetsRows += [PSCustomObject]@{
            snapshot_utc = $snapshotUtc
            organization = $orgSlug
            source_scope = $budgetSource
            budget_id = $budget.id
            budget_scope = $budget.budget_scope
            budget_entity_name = if ($budget.PSObject.Properties.Name -contains 'budget_entity_name') { $budget.budget_entity_name } else { $null }
            user = if ($budget.PSObject.Properties.Name -contains 'user') { $budget.user } else { $null }
            budget_product_sku = if ($budget.PSObject.Properties.Name -contains 'budget_product_sku') { $budget.budget_product_sku } else { $null }
            budget_type = if ($budget.PSObject.Properties.Name -contains 'budget_type') { $budget.budget_type } else { $null }
            budget_amount = if ($budget.PSObject.Properties.Name -contains 'budget_amount') { $budget.budget_amount } else { $null }
            consumed_amount = $consumedAmount
            prevent_further_usage = if ($budget.PSObject.Properties.Name -contains 'prevent_further_usage') { $budget.prevent_further_usage } else { $null }
            will_alert = if ($budget.PSObject.Properties.Name -contains 'budget_alerting' -and $budget.budget_alerting) { $budget.budget_alerting.will_alert } else { $null }
            alert_recipients = $alertRecipients
        }
    }
 
    $budgetsCurrentFlatPath = Join-Path $outPath "budgets_current.csv"
    $budgetsRows |
        Select-Object snapshot_utc, organization, source_scope, budget_id, budget_scope, budget_entity_name, user, budget_product_sku, budget_type, budget_amount, consumed_amount, prevent_further_usage, will_alert, alert_recipients |
        Export-Csv -Path $budgetsCurrentFlatPath -NoTypeInformation -Encoding utf8
 
    Write-Host "Budgets current state ($budgetSource): $($budgetsRows.Count) budgets"
}
catch {
    Write-Host "Warning: Failed to download budgets ($_). Skipping." -ForegroundColor Yellow
}
 
Write-Host "Done. Files created in: $outPath"
if (-not $BudgetOnly) {
    Write-Host "- $usageMetaPath"
    Write-Host "- $combinedUsagePath"
    Write-Host "- $seatsPath"
    Write-Host "- $seatsFlatPath"
}
if ($billingPath) {
    Write-Host "- $billingPath"
    Write-Host "- $billingFlatPath"
}
if ($costCenterBillingPath) {
    Write-Host "- $costCenterBillingPath"
    Write-Host "- $costCenterBillingFlatPath"
}
if ($budgetsCurrentPath) {
    Write-Host "- $budgetsCurrentPath"
    Write-Host "- $budgetsCurrentFlatPath"
}
