const { OpenAI } = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const generateCodeReview = async (code, question, testResults) => {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content:
            "You are an expert code reviewer. Analyze code for coding assessments.",
        },
        {
          role: "user",
          content: `
            Question: ${question}
            Code: ${code}
            Test Results: ${JSON.stringify(testResults)}
            
            Provide:
            1. Strengths (3 points)
            2. Weaknesses (3 points)
            3. Time Complexity
            4. Space Complexity
            5. Suggestions for improvement (3 points)
          `,
        },
      ],
      temperature: 0.7,
      max_tokens: 500,
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error("AI Review error:", error);
    return null;
  }
};

module.exports = { generateCodeReview };
