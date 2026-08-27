# GetSkillGraph200ResponseMetadata


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**edges** | **int** |  |
**generated_at** | **str** |  |
**include_history** | **bool** |  |
**limits** | [**GetSkillGraph200ResponseMetadataLimits**](GetSkillGraph200ResponseMetadataLimits.md) |  |
**nodes** | **int** |  |
**truncated** | **bool** |  |
**truncated_edges** | **int** |  |
**truncated_nodes** | **int** |  |

## Example

```python
from openapi_client.models.get_skill_graph200_response_metadata import GetSkillGraph200ResponseMetadata

# TODO update the JSON string below
json = "{}"
# create an instance of GetSkillGraph200ResponseMetadata from a JSON string
get_skill_graph200_response_metadata_instance = GetSkillGraph200ResponseMetadata.from_json(json)
# print the JSON string representation of the object
print(GetSkillGraph200ResponseMetadata.to_json())

# convert the object into a dict
get_skill_graph200_response_metadata_dict = get_skill_graph200_response_metadata_instance.to_dict()
# create an instance of GetSkillGraph200ResponseMetadata from a dict
get_skill_graph200_response_metadata_from_dict = GetSkillGraph200ResponseMetadata.from_dict(get_skill_graph200_response_metadata_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
