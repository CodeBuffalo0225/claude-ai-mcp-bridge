#!/usr/bin/env node

// ============================================================================
//  CutPilot AI — Style Learning CLI
//  One-shot pipeline: harvest .prproj files → compute stats → Claude API →
//  save Style DNA Profile.
// ============================================================================

import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import ora from 'ora';
import chalk from 'chalk';
import { harvestDirectory, harvestFiles, findPrprojFiles } from './project-harvester.js';
import { analyzeStyle } from './style-analyzer.js';
import { saveProfile, loadProfile, profileExists, clearProfile } from './style-profile-store.js';

// ── Argument Parsing ────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    dir: { type: 'string', short: 'd' },
    files: { type: 'string', short: 'f' },
    clear: { type: 'boolean', default: false },
    show: { type: 'boolean', default: false },
  },
  strict: false,
});

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log(chalk.bold('🎬 CutPilot AI — Style Learning Pipeline'));
  console.log(chalk.gray('─'.repeat(48)));
  console.log('');

  // --clear
  if (args.clear) {
    clearProfile();
    console.log(chalk.green('✅ Style profile cleared.'));
    process.exit(0);
  }

  // --show
  if (args.show) {
    const profile = loadProfile();
    if (!profile) {
      console.log(chalk.yellow('No style profile found.'));
      console.log(chalk.gray('Run: npm run learn-style -- --dir /path/to/projects'));
    } else {
      console.log(chalk.bold(`Profile: ${profile.profile_name}`));
      console.log(profile.style_summary);
      console.log('');
      console.log(chalk.gray(`Projects: ${profile.analyzed_project_count} | Sequences: ${profile.analyzed_sequence_count}`));
      console.log(chalk.gray(`Generated: ${profile.generated_at || profile._savedAt}`));
      if (profile.stale) {
        console.log(chalk.yellow('⚠ Profile is 30+ days old. Consider re-running analysis.'));
      }
    }
    process.exit(0);
  }

  // Determine source
  let analyses;

  if (args.dir) {
    analyses = await harvestWithProgress(args.dir);
  } else if (args.files) {
    const filePaths = args.files.split(',').map((f) => f.trim());
    console.log(chalk.cyan(`Scanning ${filePaths.length} .prproj file(s)...`));
    analyses = await harvestFiles(filePaths);
  } else {
    // Interactive: prompt for directory
    const dirPath = await askQuestion('Enter path to directory with .prproj files: ');
    if (!dirPath.trim()) {
      console.log(chalk.red('No path provided. Exiting.'));
      process.exit(1);
    }
    analyses = await harvestWithProgress(dirPath.trim());
  }

  if (analyses.length === 0) {
    console.log(chalk.red('No sequences found. Nothing to analyze.'));
    process.exit(1);
  }

  // Summary
  const uniqueProjects = new Set(analyses.map((a) => a.sourceFile)).size;
  console.log('');
  console.log(chalk.bold(`Found ${analyses.length} sequences across ${uniqueProjects} project(s)`));
  console.log('');

  // Confirm before calling API
  const proceed = await askQuestion('Analyze style and call Claude API? (y/n) ');
  if (proceed.toLowerCase() !== 'y') {
    console.log(chalk.yellow('Cancelled.'));
    process.exit(0);
  }

  // Analyze
  const spinner = ora('Generating Style DNA Profile via Claude API...').start();
  try {
    const profile = await analyzeStyle(analyses);
    spinner.succeed('Style DNA Profile generated');

    // Save
    saveProfile(profile);

    console.log('');
    console.log(chalk.green.bold(`✅ Style profile saved: ${profile.profile_name}`));
    console.log(chalk.white(profile.style_summary));
    console.log('');
    console.log(chalk.gray('Profile will auto-inject into all future CutPilot sessions.'));
  } catch (err) {
    spinner.fail('Style analysis failed');
    console.error(chalk.red(err.message));
    process.exit(1);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function harvestWithProgress(dirPath) {
  const files = findPrprojFiles(dirPath);
  console.log(chalk.cyan(`Scanning ${files.length} .prproj file(s)...`));
  if (files.length === 0) return [];
  return harvestFiles(files);
}

function askQuestion(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(chalk.cyan(prompt), (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

main().catch((err) => {
  console.error(chalk.red(`Fatal: ${err.message}`));
  process.exit(1);
});
