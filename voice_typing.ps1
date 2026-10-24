param([ValidateSet('inspect', 'resume')][string]$Action = 'inspect')
$ErrorActionPreference = 'Stop'

# Inspect only the Windows text-input host, never unrelated application controls.
# Labels vary by Windows build/language. Unknown controls are deliberately untouched.
try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $hosts = @(Get-Process -Name TextInputHost,InputApp -ErrorAction SilentlyContinue)
    $desktop = [System.Windows.Automation.AutomationElement]::RootElement
    $roots = $desktop.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    $hostIds = @($hosts | ForEach-Object { $_.Id })
    $panels = @()
    foreach ($root in $roots) {
        if ($root.Current.ProcessId -in $hostIds -and -not $root.Current.IsOffscreen) { $panels += $root }
    }
    $state = if ($panels.Count) { 'unknown' } else { 'closed' }
    $mic = $null
    foreach ($panel in $panels) {
        $elements = $panel.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
        $isVoicePanel = $panel.Current.Name -match '(?i)voice typing|dictation'
        $listeningText = $false
        $genericMic = $null
        foreach ($element in $elements) {
            if ($element.Current.IsOffscreen) { continue }
            $name = $element.Current.Name.Trim()
            $help = $element.Current.HelpText.Trim()
            if ($name -match '(?i)voice typing|dictation|^(start|stop|pause|resume) listening$|^listening(\.\.\.|…)?$') { $isVoicePanel = $true }
            if ($name -match '(?i)^listening(\.\.\.|…)?$') { $listeningText = $true }
            if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button) {
                if ($name -match '(?i)^microphone$') { $genericMic = $element }
                $label = if ($name -match '(?i)^microphone$') { $help } else { $name }
                if ($label -match '(?i)^(stop|pause) (listening|voice typing|dictation)(\s*\(.*\))?$') { $state = 'listening'; $mic = $element }
                elseif ($label -match '(?i)^(start|resume) (listening|voice typing|dictation)(\s*\(.*\))?$') { $state = 'paused'; $mic = $element }
            }
        }
        if ($isVoicePanel -and $state -eq 'unknown') {
            if ($listeningText) { $state = 'listening' }
            elseif ($genericMic) {
                $toggle = $null
                if ($genericMic.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$toggle)) {
                    if ($toggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On) { $state = 'listening' }
                    elseif ($toggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::Off) { $state = 'paused'; $mic = $genericMic }
                }
            }
        }
        if ($isVoicePanel -and $state -eq 'closed') { $state = 'unknown' }
    }
    $activated = $false
    if ($Action -eq 'resume' -and $state -eq 'paused' -and $mic -and $mic.Current.IsEnabled) {
        $pattern = $null
        if ($mic.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
            $pattern.Invoke()
            $activated = $true
            # Activation is not confirmation that the speech service is listening.
            $state = 'starting'
        } elseif ($mic.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) {
            if ($pattern.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::Off) {
                $pattern.Toggle()
                $activated = $true
                $state = 'starting'
            }
        }
    }
    @{ state = $state; activated = $activated } | ConvertTo-Json -Compress
} catch {
    @{ state = 'unavailable'; activated = $false } | ConvertTo-Json -Compress
}
