import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateFonts } from 'fantasticon';

// let's use fantasticon instead?!!!
// Get current directory (equivalent to __dirname in CommonJS)
// Get current directory (equivalent to __dirname in CommonJS)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function generateFont() {
  try {
    const inputDir = path.resolve(__dirname, "..", "resources", "dark");
    const outputDir = path.resolve(__dirname, "..", "resources");
    const fontName = "source-tools-icons";

    // Generate the font using fantasticon
    const result = await generateFonts({
      inputDir,
      outputDir,
      name: fontName,
      fontTypes: ['woff'],
      assetTypes: ['json'], // Only generate json metadata
      formatOptions: {
        json: {
          indent: 2
        }
      },
      pathOptions: {
        json: path.resolve(__dirname, "..", "resources", `${fontName}.json`)
      }
    });

    console.log('Font generated successfully');

    // Clean up unwanted files
    const fontDir = path.resolve(__dirname, "..", "resources");

    // no json
    // Read the metadata JSON file to get icon data
    const jsonPath = path.resolve(fontDir, `${fontName}.json`);
    const metadata = JSON.parse(await fs.readFile(jsonPath, 'utf8'));

    // Generate the icons object for package.json
    const icons = {};

    for (const [name, codePoint] of Object.entries(metadata)) {
      icons[`sti-${name}`] = {
        description: `Source Tools ${name.replace(/-/g, ' ')} icon`,
        default: {
          fontPath: `./resources/${fontName}.woff`,
          fontCharacter: `\\u${codePoint.toString(16)}`
        }
      };
    }

    // Update the package.json file
    const packageJsonPath = path.resolve(__dirname, "..", "package.json");
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));

    // Update or add the icons property
    packageJson.contributes = packageJson.contributes || {};
    packageJson.contributes.icons = icons;

    // Write the updated package.json
    await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2), 'utf8');

    console.log('Updated package.json with icon contributions');

    // List of files to remove
    const filesToRemove = [
      `${fontDir}/${fontName}.json`,
      // `${fontDir}/${fontName}.html`,
      // `${fontDir}/${fontName}.css`,
      // `${fontDir}/${fontName}.scss`,
      // `${fontDir}/${fontName}.sass`,
      // `${fontDir}/${fontName}.less`,
      // `${fontDir}/${fontName}.ttf`,
      // `${fontDir}/${fontName}.eot`,
      // `${fontDir}/${fontName}.svg`,
      // `${fontDir}/${fontName}.woff2`
    ];

    // Keep only the .woff file and remove everything else
    for (const file of filesToRemove) {
      try {
        await fs.access(file);
        await fs.unlink(file);
        console.log(`Removed: ${file}`);
      } catch (error) {
        // File doesn't exist, just continue
      }
    }
  } catch (err) {
    console.error('Font generation failed:', err);
  }
}

// Run the async function
generateFont();
