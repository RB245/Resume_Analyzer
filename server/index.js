const express = require('express');
const multer = require('multer');
const cors = require('cors');
const pdf = require('pdf-parse');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Configure multer for file uploads
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Initialize Gemini AI
const genAI = process.env.GOOGLE_API_KEY ? new GoogleGenerativeAI(process.env.GOOGLE_API_KEY) : null;

// Extract text with line numbers and page info
async function extractTextWithLineNumbers(buffer) {
  try {
    const data = await pdf(buffer);
    const fullText = data.text;
    const lines = fullText.split('\n');
    const linesPerPage = 50;
    
    const linesWithPages = lines.map((line, index) => ({
      lineNumber: index + 1,
      content: line.trim(),
      estimatedPage: Math.ceil((index + 1) / linesPerPage)
    }));
    
    return {
      fullText,
      lines: linesWithPages,
      totalLines: lines.length,
      estimatedPages: Math.ceil(lines.length / linesPerPage)
    };
  } catch (error) {
    throw new Error('Failed to extract text from PDF: ' + error.message);
  }
}

// Find skill occurrences with context
function findSkillOccurrences(textData, skill) {
  const skillLower = skill.toLowerCase();
  const occurrences = [];
  
  textData.lines.forEach(line => {
    const lineContentLower = line.content.toLowerCase();
    let startIndex = 0;
    
    while ((startIndex = lineContentLower.indexOf(skillLower, startIndex)) !== -1) {
      const contextStart = Math.max(0, startIndex - 30);
      const contextEnd = Math.min(line.content.length, startIndex + skillLower.length + 30);
      const context = line.content.substring(contextStart, contextEnd);
      
      occurrences.push({
        lineNumber: line.lineNumber,
        estimatedPage: line.estimatedPage,
        context: context
      });
      
      startIndex += skillLower.length;
    }
  });
  
  return occurrences;
}

// Basic skills analysis
function analyzeSkills(resumeTexts, requiredSkills, fileNames) {
  const skillsArray = requiredSkills.split(',').map(s => s.trim());
  
  const results = resumeTexts.map((textData, index) => {
    const matched = [];
    const missing = [];
    
    skillsArray.forEach(skill => {
      const occurrences = findSkillOccurrences(textData, skill);
      
      if (occurrences.length > 0) {
        matched.push({
          skill: skill,
          occurrences: occurrences,
          totalOccurrences: occurrences.length
        });
      } else {
        missing.push(skill);
      }
    });
    
    const matchPercentage = Math.round((matched.length / skillsArray.length) * 100);
    const isEligible = matchPercentage >= 60;
    
    return {
      fileName: fileNames[index] || `Resume ${index + 1}`,
      eligible: isEligible,
      matchPercentage,
      matched,
      missing,
      summary: `Found ${matched.length}/${skillsArray.length} required skills`,
      totalLines: textData.totalLines,
      estimatedPages: textData.estimatedPages
    };
  });
  
  return results;
}

// Enhanced AI analysis
async function analyzeSkillsWithAI(resumeTexts, requiredSkills, fileNames) {
  if (!genAI) {
    return analyzeSkills(resumeTexts, requiredSkills, fileNames);
  }
  
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });
    const results = [];
    
    for (let i = 0; i < resumeTexts.length; i++) {
      const textData = resumeTexts[i];
      const basicResult = analyzeSkills([textData], requiredSkills, [fileNames[i]])[0];
      
      const prompt = `Analyze this resume for skills: ${requiredSkills}

RESUME: ${textData.fullText}

Rate overall match percentage (0-100) and determine eligibility (60%+ threshold).
Respond in JSON format:
{
  "overall_score": 85,
  "eligible": true,
  "summary": "brief summary"
}`;

      try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const aiText = response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        const aiResult = JSON.parse(aiText);
        
        results.push({
          ...basicResult,
          matchPercentage: aiResult.overall_score,
          eligible: aiResult.eligible,
          summary: aiResult.summary
        });
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
      } catch (error) {
        console.error(`AI analysis failed for resume ${i + 1}:`, error);
        results.push(basicResult);
      }
    }
    
    return results;
    
  } catch (error) {
    console.error('AI analysis failed, using basic analysis:', error);
    return analyzeSkills(resumeTexts, requiredSkills, fileNames);
  }
}

// Skills eligibility check endpoint
app.post('/api/skills-check', upload.array('resumes'), async (req, res) => {
  try {
    const { skills } = req.body;
    const files = req.files;

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No resume files uploaded' });
    }

    if (!skills) {
      return res.status(400).json({ error: 'Required skills not provided' });
    }

    console.log(`Processing ${files.length} resumes for skills: ${skills}`);

    const resumeTexts = [];
    const fileNames = [];
    
    for (const file of files) {
      const textData = await extractTextWithLineNumbers(file.buffer);
      resumeTexts.push(textData);
      fileNames.push(file.originalname);
    }

    const results = await analyzeSkillsWithAI(resumeTexts, skills, fileNames);
    
    res.json({
      success: true,
      totalResumes: files.length,
      eligibleCount: results.filter(r => r.eligible).length,
      results
    });

  } catch (error) {
    console.error('Skills check error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Skills analysis failed', 
      details: error.message 
    });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK',
    timestamp: new Date().toISOString(),
    aiEnabled: !!genAI
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`AI Integration: ${genAI ? 'Google Gemini Enabled' : 'Basic Mode'}`);
});

module.exports = app;