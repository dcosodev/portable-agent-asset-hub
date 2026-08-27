# ReadSkillResource200Response


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**bytes** | **str** | Base64-encoded resource bytes. |
**encoding** | **str** |  |
**mime** | **str** |  |
**mode** | **int** |  |
**relative_path** | **str** |  |
**sha256** | **str** |  |
**size** | **int** |  |

## Example

```python
from openapi_client.models.read_skill_resource200_response import ReadSkillResource200Response

# TODO update the JSON string below
json = "{}"
# create an instance of ReadSkillResource200Response from a JSON string
read_skill_resource200_response_instance = ReadSkillResource200Response.from_json(json)
# print the JSON string representation of the object
print(ReadSkillResource200Response.to_json())

# convert the object into a dict
read_skill_resource200_response_dict = read_skill_resource200_response_instance.to_dict()
# create an instance of ReadSkillResource200Response from a dict
read_skill_resource200_response_from_dict = ReadSkillResource200Response.from_dict(read_skill_resource200_response_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
