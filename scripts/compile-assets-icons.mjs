
import * as fsSync from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateFonts } from 'fantasticon';
import { count } from 'console';

// Get current directory (equivalent to __dirname in CommonJS)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function generateFont() {
  try {
    const inputDir = path.resolve(__dirname, "..", "resources", "dark");
    const outputDir = path.resolve(__dirname, "..", "resources");
    const fontName = "source-tracker-icons";

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
        description: `Source Tracker ${name.replace(/-/g, ' ')} icon`,
        default: {
          fontPath: `./resources/${fontName}.woff`,
          fontCharacter: `\\u${codePoint.toString(16)}`
        }
      };
    }

    // Read the package.json as a string to preserve formatting
    const packageJsonPath = path.join(process.cwd(), 'package.json');
    let packageJsonContent = fsSync.readFileSync(packageJsonPath, 'utf8');

    // Convert icons object to formatted JSON string
    const iconsJson = JSON.stringify(icons, null, 2);

    // Create properly indented version for insertion in the contributes section
    // Indent all lines except the first one with 4 spaces (2 for contributes, 2 for icons nesting)
    const formattedIconsJson = iconsJson
      .split('\n')
      .map((line, index) => index === 0 ? line : '    ' + line)
      .join('\n')
      .replace(/\\\\u/g, '\\u');

    // Helper function to properly detect the icons section with brace counting
    function findIconsSection(content) {
      const contributesMatch = content.match(/"contributes"\s*:\s*\{/);
      if (!contributesMatch) return null;

      const startPos = contributesMatch.index + contributesMatch[0].length;
      const iconsMatch = content.slice(startPos).match(/"icons"\s*:\s*\{/);
      if (!iconsMatch) return null;

      const iconsStart = startPos + iconsMatch.index + iconsMatch[0].length;
      let braceCount = 1; // We're already inside the first brace of the icons object
      let position = iconsStart;

      while (braceCount > 0 && position < content.length) {
        const char = content[position];
        if (char === '{') braceCount++;
        else if (char === '}') braceCount--;
        position++;
      }

      if (braceCount === 0) {
        return {
          exists: true,
          start: startPos + iconsMatch.index,
          end: position
        };
      }

      return {
        exists: false,
        contributesPos: contributesMatch.index + contributesMatch[0].length
      };
    }

    const iconsSection = findIconsSection(packageJsonContent);

    if (iconsSection && iconsSection.exists) {
      // Replace existing icons section with proper brace counting
      const before = packageJsonContent.substring(0, iconsSection.start);
      const after = packageJsonContent.substring(iconsSection.end);
      packageJsonContent = before + `"icons": ${formattedIconsJson}` + after;
    } else if (/"contributes"\s*:\s*\{/s.test(packageJsonContent)) {
      // Add icons to existing contributes section
      packageJsonContent = packageJsonContent.replace(
        /(["']contributes["']\s*:\s*\{)/s,
        `$1\n    "icons": ${formattedIconsJson},`
      );
    } else {
      // Add contributes section with icons if it doesn't exist
      packageJsonContent = packageJsonContent.replace(
        /(\s*\}\s*)$/,
        `,\n  "contributes": {\n    "icons": ${formattedIconsJson}\n  }$1`
      );
    }

    // Only write the file if the content has materially changed
    const existingContent = fsSync.readFileSync(packageJsonPath, 'utf8');
    if (existingContent !== packageJsonContent) {
      fsSync.writeFileSync(packageJsonPath, packageJsonContent, 'utf8');
      console.log('Package.json updated with new icon definitions');
    } else {
      console.log('No changes to package.json needed - content is identical');
    }

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
